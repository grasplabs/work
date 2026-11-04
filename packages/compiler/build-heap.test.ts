import { execFileSync } from "node:child_process";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { build, removeScratch, scratch, versionIn } from "./build-harness.ts";
import { compilerAssets } from "./src/kit.ts";

// What a compiler isolate holds while it builds: every built-in blueprint's
// screens, its preview and its server code, one after another in one
// release's compiler, as a shared isolate builds them (build-heap.ts),
// under Node, whose V8 is workerd's. An isolate gets 128 MB.

const harness = path.join(import.meta.dirname, "build-heap.ts");
const blueprints = path.join(import.meta.dirname, "../../apps/core/blueprints");

/** The heap an isolate may use, in MB. */
const isolateHeapMb = 128;

const builtSchema = z.object({
  blueprint: z.string(),
  target: z.string(),
  ok: z.boolean(),
});

let release = "";
let files = "";

/** Each build of every blueprint with the release's compiler, under `heapMb` if given. */
const buildAll = (heapMb?: number): z.infer<typeof builtSchema>[] =>
  execFileSync(
    process.execPath,
    [
      ...(heapMb === undefined ? [] : [`--max-heap-size=${heapMb}`]),
      harness,
      "build",
      release,
      files,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  )
    .trim()
    .split("\n")
    .map((line) => builtSchema.parse(JSON.parse(line)));

// The release is built once; each run starts Node and the compiler.
describe("the compiler's heap", { timeout: 300_000 }, () => {
  beforeAll(() => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    build(assets, versionModule, "production");
    release = path.join(
      assets,
      compilerAssets.directory(versionIn(versionModule))
    );
    files = path.join(dir, "blueprints.json");
    execFileSync(process.execPath, [harness, "files", blueprints, files], {
      stdio: "pipe",
    });
  }, 300_000);

  afterAll(removeScratch);

  it("builds every blueprint's screens, preview and server code", () => {
    expect(buildAll()).toStrictEqual(
      ["board-page", "intake", "workflow-map"].flatMap((blueprint) =>
        ["screens", "preview-screens", "app"].map((target) => ({
          blueprint,
          target,
          ok: true,
        }))
      )
    );
  });

  // Not yet: the type chunks took one isolate building them all from
  // 288–320 MB to 192–208 MB. What is left is the type check's own
  // (TypeScript, about 18 MB, and what a check parses, about 88 MB for a
  // screen, `lib.dom.d.ts` the most of it) beside the transforms'
  // (Babel with the React Compiler, about 27 MB; ESLint, about 23 MB):
  // each fits on its own, so they go in isolates of their own. This
  // fails the day it passes; then it loses `fails`.
  it.fails(`builds them all in a heap of ${isolateHeapMb} MB`, () => {
    expect(buildAll(isolateHeapMb)).toHaveLength(9);
  });
});
