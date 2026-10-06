/**
 * One build at a time per assets directory, across processes. Core's own
 * build, its dev watcher's and a test's can all start at once; each reads
 * the sources and then writes a release and its version. Run together, one
 * that read older sources could finish last and put its older version over
 * a newer one, and two could remove releases under each other. A build
 * therefore takes this lock before it reads anything and holds it until it
 * has written everything: whichever runs last has read the newest sources.
 *
 * The lock is a directory next to the assets (not in them: a frontend
 * build empties those), holding one file named by its owner: its process
 * ID and when that process started. It is taken by moving a directory with
 * that file into place, which the file system does in one step and refuses
 * while the lock has a file in it.
 *
 * A lock whose owner is no longer running (a build that was killed) is
 * taken over: removing that owner's file by its name can't take a live
 * owner's, and only one of those waiting gets to. The process ID alone
 * doesn't say the owner runs, as the system gives a dead build's ID to
 * some other process in time; that process started at another moment, so
 * the owner is gone when no process has its ID or the one that has it
 * started at another time. Where the start time can't be read (no `ps`),
 * a lock older than `longestBuildMs` is taken over instead. No build
 * waits forever.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { compilerLock } from "./src/kit.ts";

/** How long a build waits before it looks at a held lock again. */
const retryMs = 200;

/**
 * Far longer than any build takes (seconds): the age at which a lock is
 * taken over when its owner's start time can't be compared.
 */
const longestBuildMs = 10 * 60_000;

/** A start time that couldn't be read, in an owner's name. */
const unknownStart = "unknown";

/**
 * When the process `pid` started, as `ps` words it, fit for a file name;
 * or `unknownStart` when it has ended or there is no `ps` to ask.
 */
export const startOf = (pid: number): string => {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return started === ""
      ? unknownStart
      : started.replaceAll(/[^\dA-Za-z]+/gu, "-");
  } catch {
    return unknownStart;
  }
};

/** The name of the file a lock's owner has in it. */
export const ownerName = (pid: number, started: string): string =>
  `${pid}.${started}`;

/** What the file system says when the lock is held: it has a file in it. */
const heldCodes = new Set(["ENOTEMPTY", "EEXIST", "EPERM"]);

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

/** Whether a process with this ID runs: one we may not signal does too. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
};

/** Runs `remove`; what it removes may be gone or taken already. */
const quietly = (remove: () => void): void => {
  try {
    remove();
  } catch {
    // Another build got there first, or the lock isn't ours to remove.
  }
};

/**
 * Whether the build that left the file `owner` in `lock` still runs: a
 * process has its ID and started when it did, or, where that can't be
 * compared, the lock is younger than `longestBuildMs`.
 */
const ownerRuns = (lock: string, owner: string): boolean => {
  const [id = "", recorded = unknownStart] = owner.split(".");
  const pid = Number(id);
  if (!(Number.isInteger(pid) && isRunning(pid))) {
    return false;
  }
  const started = startOf(pid);
  if (recorded !== unknownStart && started !== unknownStart) {
    return recorded === started;
  }
  try {
    return (
      Date.now() - statSync(path.join(lock, owner)).mtimeMs < longestBuildMs
    );
  } catch {
    // Released since we listed it.
    return false;
  }
};

/**
 * Clears what a killed build left of `lock`: its owner's file, and the
 * lock itself once it is empty. A live owner's file stays, and with it
 * the lock. Says whether a live build holds it.
 */
const heldByLiveBuild = (lock: string): boolean => {
  let owners: string[];
  try {
    owners = readdirSync(lock);
  } catch {
    // Released since we tried to take it.
    return false;
  }
  let live = false;
  for (const owner of owners) {
    if (ownerRuns(lock, owner)) {
      live = true;
    } else {
      quietly(() => {
        rmSync(path.join(lock, owner));
      });
    }
  }
  if (!live) {
    // Only if it is empty: a build that just took it keeps it.
    quietly(() => {
      rmdirSync(lock);
    });
  }
  return live;
};

/**
 * Runs `build` while holding the lock of `assets`, waiting for any build
 * that holds it now. The lock is released when `build` ends, however it
 * ends, and when this process is told to stop.
 */
export const withBuildLock = async <T>(
  assets: string,
  build: () => Promise<T>
): Promise<T> => {
  const lock = compilerLock(path.resolve(assets));
  const mine = `${lock}.${process.pid}`;
  const own = ownerName(process.pid, startOf(process.pid));
  mkdirSync(path.dirname(lock), { recursive: true });
  rmSync(mine, { recursive: true, force: true });
  mkdirSync(mine);
  writeFileSync(path.join(mine, own), "");
  const release = (): void => {
    quietly(() => {
      rmSync(path.join(lock, own));
    });
    quietly(() => {
      rmdirSync(lock);
    });
  };
  let told = false;
  try {
    for (;;) {
      try {
        renameSync(mine, lock);
        break;
      } catch (error) {
        if (!heldCodes.has(codeOf(error) ?? "")) {
          throw error;
        }
      }
      if (heldByLiveBuild(lock)) {
        if (!told) {
          told = true;
          console.error("Waiting for another build of the screen compiler.");
        }
        // oxlint-disable-next-line no-await-in-loop -- one look at a time
        await wait(retryMs);
      }
    }
  } catch (error) {
    rmSync(mine, { recursive: true, force: true });
    throw error;
  }
  const stopped = (): void => {
    release();
    process.exit(1);
  };
  process.once("SIGINT", stopped);
  process.once("SIGTERM", stopped);
  try {
    return await build();
  } finally {
    process.off("SIGINT", stopped);
    process.off("SIGTERM", stopped);
    release();
  }
};
