import { readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  releaseFiles,
  removeScratch,
  scratch,
  startBuild,
  wholeRelease,
} from "./build-harness.ts";

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(removeScratch);

  it("builds one at a time when two builds start together", async () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");

    const builds = [
      startBuild(assets, versionModule),
      startBuild(assets, versionModule),
    ];

    await expect(
      Promise.all(builds.map(async ({ done }) => await done))
    ).resolves.toStrictEqual([0, 0]);
    expect(wholeRelease(assets, versionModule)).toStrictEqual(releaseFiles);
    // No lock and nothing half-written left, next to the assets or in them.
    expect([readdirSync(dir).toSorted(), readdirSync(assets)]).toStrictEqual([
      ["assets", "version.js"],
      ["_compiler"],
    ]);
  });
});
