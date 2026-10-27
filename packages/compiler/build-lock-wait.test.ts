import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  heldLock,
  releaseFiles,
  removeScratch,
  scratch,
  startBuild,
  wholeRelease,
} from "./build-harness.ts";
import { startOf } from "./build-lock.ts";

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(removeScratch);

  it("waits for a build that holds the assets' lock, then builds", async () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    // Another build, as far as the lock says: this process, which runs
    // and started when the lock says it did.
    const lock = heldLock(assets, process.pid, startOf(process.pid));

    const building = startBuild(assets, versionModule);
    await building.waiting;
    // It has written nothing while it waits.
    expect([existsSync(assets), existsSync(versionModule)]).toStrictEqual([
      false,
      false,
    ]);
    rmSync(lock, { recursive: true });

    await expect(building.done).resolves.toBe(0);
    expect(wholeRelease(assets, versionModule)).toStrictEqual(releaseFiles);
    expect(readdirSync(dir).toSorted()).toStrictEqual(["assets", "version.js"]);
  });
});
