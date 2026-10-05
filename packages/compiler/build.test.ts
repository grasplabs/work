import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { compilerAssets } from "./src/kit.ts";

// The build as core, its tests and the dev watcher run it: a process that
// writes a release into an assets directory and its version into a module.
// Core has the version in its code and reads the release by it, so what
// matters is that the two always agree, whoever builds and when.

const buildScript = path.join(import.meta.dirname, "build.ts");

const made: string[] = [];

/** An empty directory of this test's own. */
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-compiler-"));
  made.push(dir);
  return dir;
};

/** Builds into `assets`, as a process with `NODE_ENV` set to `mode`. */
const build = (assets: string, versionModule: string, mode: string): void => {
  execFileSync(process.execPath, [buildScript, assets, versionModule], {
    env: { ...process.env, NODE_ENV: mode },
    stdio: "pipe",
  });
};

const versionIn = (versionModule: string): string =>
  /"(?<version>[0-9a-f]+)"/u.exec(readFileSync(versionModule, "utf-8"))?.groups
    ?.version ?? "";

const releasesIn = (assets: string): string[] =>
  readdirSync(path.join(assets, compilerAssets.directory(""))).toSorted();

// Each build starts Node, TypeScript and three bundles.
describe("the compiler's build", { timeout: 120_000 }, () => {
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names in its version module a release that is whole in its assets, the same whoever builds", () => {
    const dir = scratch();
    const dev = path.join(dir, "dev-assets");
    const tests = path.join(dir, "test-assets");
    const devVersion = path.join(dir, "dev-version.js");
    const testVersion = path.join(dir, "test-version.js");

    build(dev, devVersion, "development");
    // A test run builds too, with its own NODE_ENV, into its own assets.
    build(tests, testVersion, "test");

    // The dev server's version still names what its assets have.
    const version = versionIn(devVersion);
    expect(version).not.toBe("");
    expect(releasesIn(dev)).toStrictEqual([version]);
    const release = path.join(dev, compilerAssets.directory(version));
    expect(readdirSync(release).toSorted()).toStrictEqual(
      [
        compilerAssets.source,
        compilerAssets.kit,
        compilerAssets.kitModules,
        compilerAssets.sdkModules,
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

  it("keeps the release a running server was built for until the next build, and drops older ones", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    const releases = path.join(assets, compilerAssets.directory(""));
    // A server runs on `running`; `older` is left from before it.
    for (const release of ["0000000000000001", "0000000000000002"]) {
      mkdirSync(path.join(releases, release), { recursive: true });
    }
    const [older = "", running = ""] = releasesIn(assets);
    writeFileSync(versionModule, `export const version = "${running}";\n`);

    build(assets, versionModule, "production");

    const version = versionIn(versionModule);
    expect(releasesIn(assets)).toStrictEqual([running, version].toSorted());
    expect(existsSync(path.join(releases, older))).toBeFalsy();
  });
});
