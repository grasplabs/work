// Records how long each test file takes, for the split between CI's
// shards (scripts/test-shards.ts), from the shards' test-progress
// artifacts (scripts/stall-reporter.ts writes them):
//
//   gh run download <run> -n test-progress-1-of-4 -D runs/<run>-1
//   ...
//   vp run test:durations runs/*/test-progress.log
//
// Several runs make it steadier: each file takes the median of the runs
// it ran in. Files the logs don't name keep the time they had. Rewrites
// scripts/test-durations.json.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { byKey } from "./test-shards.ts";

/** A finished test in a progress log: when, how it ended, how long it took, and its file and name. */
const progressLine =
  /^\S+ \S+(?: (?<ms>\d+)ms)? (?<project>\S+) (?<file>\S+) > /u;

/** Seconds per file, `<project> <file>`, as one progress log has them: the sum of its tests. */
export const fileSecondsIn = (log: string): Map<string, number> => {
  const seconds = new Map<string, number>();
  for (const line of log.split("\n")) {
    const match = progressLine.exec(line);
    if (match?.groups === undefined) {
      continue;
    }
    const { ms, project, file } = match.groups;
    const key = `${project} ${file}`;
    seconds.set(key, (seconds.get(key) ?? 0) + Number(ms ?? 0) / 1000);
  }
  return seconds;
};

/** The durations as the file keeps them: seconds per `<project> <file>`. */
export const parseDurations = (json: string): Record<string, number> =>
  z.record(z.string(), z.number()).parse(JSON.parse(json));

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * `known` updated from `logs`: each file the logs name takes the median of
 * its times in them, rounded to a tenth of a second; the rest keep theirs.
 */
export const updatedDurations = (
  known: Readonly<Record<string, number>>,
  logs: readonly string[]
): Record<string, number> => {
  const runs = new Map<string, number[]>();
  for (const log of logs) {
    for (const [key, seconds] of fileSecondsIn(log)) {
      runs.set(key, [...(runs.get(key) ?? []), seconds]);
    }
  }
  const durations = new Map(Object.entries(known));
  for (const [key, seconds] of runs) {
    durations.set(key, Math.round(median(seconds) * 10) / 10);
  }
  return Object.fromEntries([...durations].toSorted(([a], [b]) => byKey(a, b)));
};

/** Where the durations are kept. */
export const durationsFile = fileURLToPath(
  new URL("test-durations.json", import.meta.url)
);

if (import.meta.main) {
  const logs = process.argv.slice(2);
  if (logs.length === 0) {
    console.error("Usage: vp run test:durations <test-progress.log>...");
    process.exitCode = 1;
  } else {
    const known = parseDurations(readFileSync(durationsFile, "utf-8"));
    const durations = updatedDurations(
      known,
      logs.map((log) => readFileSync(log, "utf-8"))
    );
    writeFileSync(durationsFile, `${JSON.stringify(durations, null, 2)}\n`);
  }
}
