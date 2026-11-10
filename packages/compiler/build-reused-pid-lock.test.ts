import { readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  build,
  heldLock,
  releaseFiles,
  removeScratch,
  scratch,
  wholeRelease,
} from "./build-harness.ts";

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(removeScratch);

  it("takes over the lock of a build whose process ID another process has now", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    // The owner's ID is this process's, which runs, but the owner started
    // at another time: it was another process, which is gone.
    heldLock(assets, process.pid, "Thu-Jan-1-00-00-00-1970");

    build(assets, versionModule, "production");

    expect(wholeRelease(assets, versionModule)).toStrictEqual(releaseFiles);
    expect(readdirSync(dir).toSorted()).toStrictEqual(["assets", "version.js"]);
  });
});
