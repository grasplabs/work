import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  baseline,
  build,
  releasesIn,
  removeScratch,
  scratch,
  versionIn,
} from "./build-harness.ts";
import { compilerAssets } from "./src/kit.ts";

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(removeScratch);

  it("names in its version module a release that is whole in its assets, the same whoever builds", () => {
    // As CI builds a release (the shared one, a production build), then
    // as a test run builds, with its own NODE_ENV, into its own assets.
    const { assets: dev, versionModule: devVersion } = baseline();
    const dir = scratch();
    const tests = path.join(dir, "test-assets");
    const testVersion = path.join(dir, "test-version.js");
    build(tests, testVersion, "test");

    // The first version still names what its assets have.
    const version = versionIn(devVersion);
    expect(version).not.toBe("");
    expect(releasesIn(dev)).toStrictEqual([version]);
    const release = path.join(dev, compilerAssets.directory(version));
    expect(readdirSync(release).toSorted()).toStrictEqual(
      [
        compilerAssets.source,
        compilerAssets.kit,
        compilerAssets.kitModules,
        compilerAssets.kitPreviewModules,
        compilerAssets.workflowSdkModules,
        compilerAssets.serverSdkModules,
        compilerAssets.packageBuilder,
        compilerAssets.ultracite,
        compilerAssets.oxcWasm,
        compilerAssets.esbuildWasm,
        compilerAssets.checker,
        compilerAssets.types,
        compilerAssets.tsrsWasm,
      ].toSorted()
    );
    // The same sources are the same release, under any NODE_ENV.
    expect(versionIn(testVersion)).toBe(version);
    expect(
      readFileSync(
        path.join(
          tests,
          compilerAssets.directory(version),
          compilerAssets.kitModules
        ),
        "utf-8"
      )
    ).toBe(
      readFileSync(path.join(release, compilerAssets.kitModules), "utf-8")
    );
  });
});
