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

// Two builds one after the other, each Node, TypeScript and three bundles:
// 28 to 36 s in CI's shards, 15 s on a laptop (November 2026). Allowed
// two and a half times CI's, so a stuck build fails here and its retry
// starts within half the shard's step, not after 4 minutes of it.
describe("the compiler's build", { timeout: 90_000 }, () => {
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
