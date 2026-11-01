/**
 * The build as core, its tests and the dev watcher run it: a process that
 * writes a release into an assets directory and its version into a module.
 * Core has the version in its code and reads the release by it, so what
 * matters is that the two always agree, whoever builds and when.
 *
 * Shared by the build's test files (build-*.test.ts), split so they can
 * run apart: each starts several builds. Each file removes its scratch
 * directories after each test, with `afterEach(removeScratch)`.
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ownerName } from "./build-lock.ts";
import { compilerAssets, compilerLock } from "./src/kit.ts";

const buildScript = path.join(import.meta.dirname, "build.ts");

const made: string[] = [];

/** An empty directory of this test's own. */
export const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-compiler-"));
  made.push(dir);
  return dir;
};

/** Removes the directories `scratch` made. */
export const removeScratch = (): void => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Builds into `assets`, as a process with `NODE_ENV` set to `mode`. */
export const build = (
  assets: string,
  versionModule: string,
  mode: string
): void => {
  execFileSync(process.execPath, [buildScript, assets, versionModule], {
    env: { ...process.env, NODE_ENV: mode },
    stdio: "pipe",
  });
};

export const versionIn = (versionModule: string): string =>
  /"(?<version>[0-9a-f]+)"/u.exec(readFileSync(versionModule, "utf-8"))?.groups
    ?.version ?? "";

export const releasesIn = (assets: string): string[] =>
  readdirSync(path.join(assets, compilerAssets.directory(""))).toSorted();

/**
 * A build into `assets` that runs on its own: resolves to its exit code,
 * and `waiting` resolves once it says another build holds the lock.
 */
export const startBuild = (
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
  const done = (async () => {
    const exited: unknown[] = await once(child, "exit");
    const [code] = exited;
    return typeof code === "number" ? code : null;
  })();
  return { done, waiting };
};

/**
 * Holds the lock of `assets` as a build would whose process is `pid`,
 * started at `started`; returns the lock.
 */
export const heldLock = (
  assets: string,
  pid: number,
  started: string
): string => {
  const lock = compilerLock(assets);
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, ownerName(pid, started)), "");
  return lock;
};

/** The files of the one release `assets` has, or what is wrong with it. */
export const wholeRelease = (
  assets: string,
  versionModule: string
): string[] => {
  const [release = "", ...others] = releasesIn(assets);
  return release === versionIn(versionModule) && others.length === 0
    ? readdirSync(
        path.join(assets, compilerAssets.directory(release))
      ).toSorted()
    : [`not one release named by the version: ${release}, ${others.join(",")}`];
};

export const releaseFiles = [
  compilerAssets.source,
  compilerAssets.kit,
  compilerAssets.kitModules,
  compilerAssets.kitPreviewModules,
  compilerAssets.workflowSdkModules,
  compilerAssets.serverSdkModules,
  compilerAssets.packageBuilder,
  compilerAssets.esbuildWasm,
].toSorted();

/**
 * Releases in `assets` put there by other builds, the first `fromNowMs`
 * from now and each a minute newer than the last.
 */
export const earlierReleases = (
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
