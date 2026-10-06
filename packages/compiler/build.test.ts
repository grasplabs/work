import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
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

import { ownerName, startOf } from "./build-lock.ts";
import { compilerAssets, compilerLock } from "./src/kit.ts";

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

/**
 * A build into `assets` that runs on its own: resolves to its exit code,
 * and `waiting` resolves once it says another build holds the lock.
 */
const startBuild = (
  assets: string,
  versionModule: string
): { done: Promise<number | null>; waiting: Promise<true> } => {
  const child = spawn(process.execPath, [buildScript, assets, versionModule], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const { promise: waiting, resolve: saidWaiting } =
    Promise.withResolvers<true>();
  let said = "";
  child.stderr.on("data", (chunk: Buffer) => {
    said += chunk.toString();
    if (said.includes("Waiting for another build")) {
      saidWaiting(true);
    }
  });
  const done = once(child, "exit").then(([code]: unknown[]) =>
    typeof code === "number" ? code : null
  );
  return { done, waiting };
};

/**
 * Holds the lock of `assets` as a build would whose process is `pid`,
 * started at `started`; returns the lock.
 */
const heldLock = (assets: string, pid: number, started: string): string => {
  const lock = compilerLock(assets);
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, ownerName(pid, started)), "");
  return lock;
};

/** The files of the one release `assets` has, or what is wrong with it. */
const wholeRelease = (assets: string, versionModule: string): string[] => {
  const [release = "", ...others] = releasesIn(assets);
  return release === versionIn(versionModule) && others.length === 0
    ? readdirSync(
        path.join(assets, compilerAssets.directory(release))
      ).toSorted()
    : [`not one release named by the version: ${release}, ${others.join(",")}`];
};

const releaseFiles = [
  compilerAssets.source,
  compilerAssets.kit,
  compilerAssets.kitModules,
  compilerAssets.sdkModules,
].toSorted();

/**
 * Releases in `assets` put there by other builds, the first `fromNowMs`
 * from now and each a minute newer than the last.
 */
const earlierReleases = (
  assets: string,
  names: string[],
  fromNowMs: number
): void => {
  const releases = path.join(assets, compilerAssets.directory(""));
  const first = Date.now() + fromNowMs;
  for (const [index, name] of names.entries()) {
    const release = path.join(releases, name);
    mkdirSync(release, { recursive: true });
    const at = new Date(first + index * 60_000);
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

  it("words a process's start time the same in every time zone and language", () => {
    const { LC_ALL: language, TZ: zone } = process.env;
    const worded: string[] = [];
    try {
      for (const [timeZone, locale] of [
        ["Asia/Tokyo", "C"],
        ["America/New_York", "nl_NL.UTF-8"],
      ] as const) {
        process.env.TZ = timeZone;
        process.env.LC_ALL = locale;
        worded.push(startOf(process.pid));
      }
    } finally {
      for (const [name, value] of [
        ["TZ", zone],
        ["LC_ALL", language],
      ] as const) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }
    }
    expect(worded[0]).not.toBe("unknown");
    expect(worded[1]).toBe(worded[0]);
  });

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

  it("takes over the lock of a build that no longer runs", () => {
    const dir = scratch();
    const assets = path.join(dir, "assets");
    const versionModule = path.join(dir, "version.js");
    // A process that has ended: its ID is no running build's.
    const { pid: ended } = spawnSync(process.execPath, ["-e", ""]);
    heldLock(assets, ended, startOf(process.pid));

    build(assets, versionModule, "production");

    expect(wholeRelease(assets, versionModule)).toStrictEqual(releaseFiles);
    expect(readdirSync(dir).toSorted()).toStrictEqual(["assets", "version.js"]);
  });

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
