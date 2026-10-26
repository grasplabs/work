import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  build,
  earlierReleases,
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
    const dir = scratch();
    const dev = path.join(dir, "dev-assets");
    const tests = path.join(dir, "test-assets");
    const devVersion = path.join(dir, "dev-version.js");
    const testVersion = path.join(dir, "test-version.js");

    // As CI builds a release, then as a test run builds, with its own
    // NODE_ENV, into its own assets.
    build(dev, devVersion, "production");
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
        compilerAssets.workflowSdkModules,
        compilerAssets.serverSdkModules,
        compilerAssets.packageBuilder,
        compilerAssets.esbuildWasm,
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

  it("keeps the release a server started on through two more builds, and drops the one before", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    // A server started on `running` and hasn't reloaded; one build has
    // finished since (`second`), and `older` is from before the server.
    const [older, running, second] = [
      "0000000000000001",
      "0000000000000002",
      "0000000000000003",
    ];
    earlierReleases(assets, [older, running, second], -3_600_000);

    // The next build finishes before the server reloads, too.
    build(assets, versionModule, "production");

    expect(releasesIn(assets)).toStrictEqual(
      [running, second, versionIn(versionModule)].toSorted()
    );
  });
});
