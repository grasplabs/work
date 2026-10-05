import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
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
const build = (
  assets: string,
  versionModule: string,
  mode: string,
  flags: string[] = []
): void => {
  execFileSync(
    process.execPath,
    [buildScript, assets, versionModule, ...flags],
    {
      env: { ...process.env, NODE_ENV: mode },
      stdio: "pipe",
    }
  );
};

const versionIn = (versionModule: string): string =>
  /"(?<version>[0-9a-f]+)"/u.exec(readFileSync(versionModule, "utf-8"))?.groups
    ?.version ?? "";

const releasesIn = (assets: string): string[] =>
  readdirSync(path.join(assets, compilerAssets.directory(""))).toSorted();

/** Releases left in `assets` by earlier builds, each a minute newer than the last. */
const earlierReleases = (assets: string, names: string[]): void => {
  const releases = path.join(assets, compilerAssets.directory(""));
  const longAgo = Date.now() - 3_600_000;
  for (const [index, name] of names.entries()) {
    const release = path.join(releases, name);
    mkdirSync(release, { recursive: true });
    const at = new Date(longAgo + index * 60_000);
    utimesSync(release, at, at);
  }
};

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

  it("leaves a release that is there as it is when the same sources build again", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    build(assets, versionModule, "production");
    const version = versionIn(versionModule);
    const release = path.join(assets, compilerAssets.directory(version));
    const identityOf = (): Record<string, number[]> =>
      Object.fromEntries(
        readdirSync(release).map((file) => {
          const { ino, mtimeMs } = statSync(path.join(release, file));
          return [file, [ino, mtimeMs]];
        })
      );
    /** The file itself and when it was last written. */
    const moduleIdentity = (): number[] => {
      const { ino, mtimeMs } = statSync(versionModule);
      return [ino, mtimeMs];
    };
    const before = { release: identityOf(), module: moduleIdentity() };

    // A server reads these files while the watcher builds: under another
    // NODE_ENV too, they are never taken away or written again. Nor is
    // the version module, which the server would reload on.
    build(assets, versionModule, "development");

    expect(versionIn(versionModule)).toBe(version);
    expect({ release: identityOf(), module: moduleIdentity() }).toStrictEqual(
      before
    );
    expect(readdirSync(assets)).toStrictEqual(["_compiler"]);
  });

  it("builds the same release with a test or a declaration among the kit's sources", () => {
    const dir = scratch();
    const versionModule = path.join(dir, "version.js");
    build(path.join(dir, "assets"), versionModule, "production");
    const version = versionIn(versionModule);
    // Next to the kit's components, as a test of one would be.
    // The build reads the kit where it is, so the files go there, for as
    // long as the build takes: removed whatever happens here, though a run
    // that is killed outright leaves them, untracked, to delete by hand.
    const added = ["probe.test.tsx", "probe.d.ts"].map((file) =>
      path.join(import.meta.dirname, "../ui/src/components", file)
    );
    try {
      for (const file of added) {
        writeFileSync(file, "export const probe = 1;\n");
      }
      build(path.join(dir, "assets"), versionModule, "production");
    } finally {
      for (const file of added) {
        rmSync(file, { force: true });
      }
    }

    expect(versionIn(versionModule)).toBe(version);
  });

  it("leaves only its own release, as a release ships", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    earlierReleases(assets, ["0000000000000001", "0000000000000002"]);

    build(assets, versionModule, "production");

    expect(releasesIn(assets)).toStrictEqual([versionIn(versionModule)]);
  });

  it("keeps, for the dev watcher, the release a server started on through two more builds", () => {
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
    earlierReleases(assets, [older, running, second]);

    // The next build finishes before the server reloads, too.
    build(assets, versionModule, "production", ["--keep=3"]);

    expect(releasesIn(assets)).toStrictEqual(
      [running, second, versionIn(versionModule)].toSorted()
    );
  });
});
