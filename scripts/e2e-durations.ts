// Records how long each e2e file takes, for the split between CI's e2e
// parts (scripts/e2e-parts.ts), from the parts' e2e-results artifacts
// (Playwright's JSON report):
//
//   gh run download <run> -p 'e2e-results-*-of-*' -D runs/<run>
//   vp run e2e:durations runs/*/*/e2e-results.json
//
// A file's time is the sum of its tests' passing attempts, in every
// browser it runs in. Several runs make it steadier: each file takes the
// median of the runs it ran in. Files the reports don't name keep the
// time they had. Rewrites scripts/e2e-durations.json.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { e2eDurationsFile } from "./e2e-parts.ts";
import { byKey } from "./test-shards.ts";

/** What this reads of a Playwright JSON report. */
interface ReportSuite {
  readonly file?: string | undefined;
  readonly suites?: readonly ReportSuite[] | undefined;
  readonly specs?:
    | readonly {
        readonly file?: string | undefined;
        readonly tests: readonly {
          readonly results: readonly {
            readonly duration: number;
            readonly status: string;
          }[];
        }[];
      }[]
    | undefined;
}

const resultSchema = z.object({
  duration: z.number(),
  status: z.string(),
});
const suiteSchema: z.ZodType<ReportSuite> = z.lazy(() =>
  z.object({
    file: z.string().optional(),
    suites: z.array(suiteSchema).optional(),
    specs: z
      .array(
        z.object({
          file: z.string().optional(),
          tests: z.array(z.object({ results: z.array(resultSchema) })),
        })
      )
      .optional(),
  })
);
const reportSchema = z.object({ suites: z.array(suiteSchema) });

/**
 * Seconds per `e2e/<file>` in one report: each test's passing attempt, or
 * its last when none passed.
 */
export const fileSecondsIn = (json: string): Map<string, number> => {
  const files = new Map<string, number>();
  const walk = (suite: ReportSuite, file?: string): void => {
    const own = suite.file ?? file;
    for (const child of suite.suites ?? []) {
      walk(child, own);
    }
    for (const spec of suite.specs ?? []) {
      const key = `e2e/${spec.file ?? own ?? ""}`;
      for (const { results } of spec.tests) {
        const counted =
          results.find(({ status }) => status === "passed") ?? results.at(-1);
        if (counted !== undefined) {
          files.set(key, (files.get(key) ?? 0) + counted.duration / 1000);
        }
      }
    }
  };
  for (const suite of reportSchema.parse(JSON.parse(json)).suites) {
    walk(suite);
  }
  return files;
};

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * `known` updated from `reports`, each a run's reports concatenated: each
 * file they name takes the median of its times, to a tenth of a second.
 */
export const updatedDurations = (
  known: Readonly<Record<string, number>>,
  runs: readonly (readonly string[])[]
): Record<string, number> => {
  const times = new Map<string, number[]>();
  for (const reports of runs) {
    const run = new Map<string, number>();
    for (const report of reports) {
      for (const [file, seconds] of fileSecondsIn(report)) {
        run.set(file, (run.get(file) ?? 0) + seconds);
      }
    }
    for (const [file, seconds] of run) {
      times.set(file, [...(times.get(file) ?? []), seconds]);
    }
  }
  const durations = new Map(Object.entries(known));
  for (const [file, seconds] of times) {
    durations.set(file, Math.round(median(seconds) * 10) / 10);
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
    // A run's parts each report their own files; the directory a report
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
