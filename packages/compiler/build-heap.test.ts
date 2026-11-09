import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  baseline,
  removeScratch,
  scratch,
  versionIn,
} from "./build-harness.ts";
import { compilerAssets } from "./src/kit.ts";

// Every built-in blueprint's pages, its preview and its server code,
// built one after another in one release's compiler, as a shared isolate
// builds them (build-heap.ts), under Node, whose V8 is workerd's, in a
// heap of `heapMb`; then each type-checked in the release's checker alone,
// as its own isolate checks them. The type chunks took what the compiler
// needs from 289–320 MB to 193–208 MB, and moving the check to its own
// isolate took it to 66–105 MB. The checker's memory is mostly tsrs's
// WebAssembly memory, which `--max-heap-size` doesn't cap: it is counted
// here beside the heap.

const harness = path.join(import.meta.dirname, "build-heap.ts");
const blueprints = path.join(import.meta.dirname, "../../apps/core/blueprints");

/** The heap the compiler's builds must fit in, in MB: a Cloudflare isolate's. */
const heapMb = 128;

/**
 * What a check may take, heap and WebAssembly together, in MB: above the
 * 128 MB past which Cloudflare replaces an isolate after its call (the
 * checker keeps nothing, so a replaced one costs a start), well below the
 * about 256 MB at which it ends one mid-call. Measured 136–162 MB on the
 * blueprints, tsrs's 80 MiB shadow stack included.
 */
const checkMb = 192;

let release = "";
let files = "";
let answers = "";

/** The JSON lines a run of the harness prints, each parsed as `schema`. */
const linesOf = <T>(output: string, schema: z.ZodType<T>): T[] =>
  output
    .trim()
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line)));

/** A run of the harness, in a Node process of its own, its heap capped at `heapMb`. */
const harnessRun = (args: string[]): string =>
  execFileSync(
    process.execPath,
    ["--expose-gc", `--max-heap-size=${heapMb}`, harness, ...args],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );

/** Every built-in core ships: each folder of `blueprints` with its manifest, by name. */
const builtIns = readdirSync(blueprints, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      existsSync(path.join(blueprints, entry.name, "blueprint.json"))
  )
  .map(({ name }) => name)
  .toSorted();

const every = <T>(each: (blueprint: string, target: string) => T): T[] =>
  builtIns.flatMap((blueprint) =>
    ["pages", "preview-pages", "app"].map((target) => each(blueprint, target))
  );

describe("a release's compiler and type checker", { timeout: 300_000 }, () => {
  beforeAll(() => {
    // The release of these sources, as a production build makes it.
    const { assets, versionModule } = baseline();
    const dir = scratch();
    release = path.join(
      assets,
      compilerAssets.directory(versionIn(versionModule))
    );
    files = path.join(dir, "blueprints.json");
    answers = path.join(dir, "answers.json");
    execFileSync(process.execPath, [harness, "files", blueprints, files], {
      stdio: "pipe",
    });
  }, 300_000);

  afterAll(removeScratch);

  it(`builds every blueprint's pages, preview and server code in ${heapMb} MB, then checks each in ${checkMb} MB of heap and WebAssembly`, () => {
    const built = linesOf(
      harnessRun(["build", release, files, answers]),
      z.object({ blueprint: z.string(), target: z.string(), ok: z.boolean() })
    );
    const checked = linesOf(
      harnessRun(["check", release, answers]),
      z.object({
        blueprint: z.string(),
        target: z.string(),
        ok: z.boolean(),
        totalMb: z.number(),
      })
    ).map(({ blueprint, target, ok, totalMb }) => ({
      blueprint,
      target,
      ok,
      within: totalMb <= checkMb,
    }));
    expect({ built, checked }).toStrictEqual({
      built: every((blueprint, target) => ({ blueprint, target, ok: true })),
      checked: every((blueprint, target) => ({
        blueprint,
        target,
        ok: true,
        within: true,
      })),
    });
  });
});
