import { execFileSync } from "node:child_process";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { build, removeScratch, scratch, versionIn } from "./build-harness.ts";
import { compilerAssets } from "./src/kit.ts";

// Every built-in blueprint's screens, its preview and its server code,
// built one after another in one release's compiler, as a shared isolate
// builds them (build-heap.ts), under Node, whose V8 is workerd's.

const harness = path.join(import.meta.dirname, "build-heap.ts");
const blueprints = path.join(import.meta.dirname, "../../apps/core/blueprints");

const builtSchema = z.object({
  blueprint: z.string(),
  target: z.string(),
  ok: z.boolean(),
});

let release = "";
let files = "";

/** Each build of every blueprint with the release's compiler. */
const buildAll = (): z.infer<typeof builtSchema>[] =>
  execFileSync(process.execPath, [harness, "build", release, files], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split("\n")
    .map((line) => builtSchema.parse(JSON.parse(line)));

// The release is built once, then run in a Node process of its own.
describe("a release's compiler", { timeout: 300_000 }, () => {
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
});
