// Records how long each e2e test takes, for the split between CI's e2e
// parts (scripts/e2e-parts.ts), from the parts' e2e-results artifacts
// (Playwright's JSON report):
//
//   gh run download <run> -p 'e2e-results-*-of-*' -D runs/<run>
//   vp run e2e:durations runs/*/*/e2e-results.json
//
// A Chromium test's time is its passing attempt's: only Chromium's are split.
// Several runs make it steadier: each test takes the median of the runs it
// ran in. Tests the reports don't name keep the time they had. Rewrites
// scripts/e2e-durations.json.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { e2eDurationsFile, testsIn } from "./e2e-parts.ts";
import { byKey } from "./test-shards.ts";

/** The project whose tests the parts split; the others run whole. */
const splitProject = "[chromium] › ";

/**
 * Seconds per Chromium test (`testsIn`'s key) in one report: its passing
 * attempt, or its last when none passed.
 */
export const testSecondsIn = (json: string): Map<string, number> => {
  const tests = new Map<string, number>();
  for (const { key, results } of testsIn(json)) {
    if (!key.startsWith(splitProject)) {
      continue;
    }
    const counted =
      results.find(({ status }) => status === "passed") ?? results.at(-1);
    if (counted !== undefined) {
      tests.set(key, (tests.get(key) ?? 0) + counted.duration / 1000);
    }
  }
  return tests;
};

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * `known` updated from `runs`, each a run's reports: each test they name
 * takes the median of its times, to a tenth of a second.
 */
export const updatedDurations = (
  known: Readonly<Record<string, number>>,
  runs: readonly (readonly string[])[]
): Record<string, number> => {
  const times = new Map<string, number[]>();
  for (const reports of runs) {
    const run = new Map<string, number>();
    for (const report of reports) {
      for (const [test, seconds] of testSecondsIn(report)) {
        run.set(test, (run.get(test) ?? 0) + seconds);
      }
    }
    for (const [test, seconds] of run) {
      times.set(test, [...(times.get(test) ?? []), seconds]);
    }
  }
  const durations = new Map(Object.entries(known));
  for (const [test, seconds] of times) {
    durations.set(test, Math.round(median(seconds) * 10) / 10);
  }
  return Object.fromEntries([...durations].toSorted(([a], [b]) => byKey(a, b)));
};

if (import.meta.main) {
  const reports = process.argv.slice(2);
  if (reports.length === 0) {
    console.error("Usage: vp run e2e:durations <e2e-results.json>...");
    process.exitCode = 1;
  } else {
    const known = z
      .record(z.string(), z.number())
      .parse(JSON.parse(readFileSync(e2eDurationsFile, "utf-8")));
    // A run's parts each report their own tests; the directory a report
    // came from names its run (runs/<run>/<part>/e2e-results.json).
    const byRun = Map.groupBy(reports, (report) =>
      report.split("/").slice(0, -2).join("/")
    );
    const durations = updatedDurations(
      known,
      [...byRun.values()].map((files) =>
        files.map((file) => readFileSync(file, "utf-8"))
      )
    );
    // Through a file of its own, so an interrupted write never leaves the
    // parts, which read this file, half a file.
    const written = `${e2eDurationsFile}.tmp`;
    writeFileSync(written, `${JSON.stringify(durations, null, 2)}\n`);
    renameSync(written, e2eDurationsFile);
  }
}
