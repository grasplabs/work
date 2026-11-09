// Which e2e tests a CI part runs, of the parallel part's Chromium tests
// (playwright.config.ts), as a Playwright test list:
//
//   node scripts/e2e-parts.ts 3/10 > part.txt
//   vp run e2e --project chromium --test-list part.txt
//
// Split by how long each test takes (scripts/e2e-durations.json), as the
// test shards are (scripts/test-shards.ts), test by test, not file by
// file: each part runs on a stack of its own, so a file's tests need not
// share one, and a file split by file was a floor no part got under (the
// UI kit's 92 pages took 4 minutes of one part, October 2026). Playwright's
// own `--shard` splits by test count, in file order, so one part held the
// slowest files and took twice as long as another (October 2026,
// GRA-1094). A test nobody timed yet is taken to take the median test's
// time. The tests come from Playwright's own listing, so a test added
// anywhere runs in exactly one part without touching this file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { byKey } from "./test-shards.ts";

const root = path.join(import.meta.dirname, "..");

/** Where the e2e tests' times are kept: seconds per test (`testKey`). */
export const e2eDurationsFile = fileURLToPath(
  new URL("e2e-durations.json", import.meta.url)
);

/**
 * How many tests a part runs at once: playwright.config.ts's `workers`.
 * The tests of one file a part runs go to one worker, one after another,
 * as Playwright hands a worker a file's tests together.
 */
export const workersPerPart = 2;

/** What this reads of a Playwright JSON report or listing. */
export interface ReportSuite {
  readonly title?: string | undefined;
  readonly file?: string | undefined;
  readonly suites?: readonly ReportSuite[] | undefined;
  readonly specs?:
    | readonly {
        readonly title: string;
        readonly file?: string | undefined;
        readonly tests: readonly {
          readonly projectName: string;
          readonly results: readonly {
            readonly duration: number;
            readonly status: string;
          }[];
        }[];
      }[]
    | undefined;
}

const suiteSchema: z.ZodType<ReportSuite> = z.lazy(() =>
  z.object({
    title: z.string().optional(),
    file: z.string().optional(),
    suites: z.array(suiteSchema).optional(),
    specs: z
      .array(
        z.object({
          title: z.string(),
          file: z.string().optional(),
          tests: z.array(
            z.object({
              projectName: z.string(),
              results: z.array(
                z.object({ duration: z.number(), status: z.string() })
              ),
            })
          ),
        })
      )
      .optional(),
  })
);
export const reportSchema = z.object({ suites: z.array(suiteSchema) });

/** A test as a part runs it. */
export interface PartTest {
  /** Its line in a Playwright test list: `[project] › file › title…`. */
  key: string;
  /** Its file, relative to e2e/. */
  file: string;
}

/** A test of a report or listing, with its attempts. */
export interface ReportTest extends PartTest {
  results: readonly { duration: number; status: string }[];
}

/**
 * Every test in a Playwright JSON report or listing (`--list
 * --reporter=json`), keyed as a test list names it: project, file, then
 * its describe blocks' titles and its own.
 */
export const testsIn = (json: string): ReportTest[] => {
  const tests: ReportTest[] = [];
  const walk = (
    suite: ReportSuite,
    file: string | undefined,
    titles: readonly string[]
  ): void => {
    const own = suite.file ?? file;
    for (const child of suite.suites ?? []) {
      walk(
        child,
        own,
        child.title === undefined ? titles : [...titles, child.title]
      );
    }
    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? own ?? "";
      for (const { projectName, results } of spec.tests) {
        tests.push({
          key: [`[${projectName}]`, specFile, ...titles, spec.title].join(
            " › "
          ),
          file: specFile,
          results,
        });
      }
    }
  };
  for (const suite of reportSchema.parse(JSON.parse(json)).suites) {
    // A top-level suite is a file: its title is the file's name.
    walk(suite, suite.file, []);
  }
  return tests;
};

/** A part as the split fills it. */
interface Part {
  keys: string[];
  /** Each worker's seconds so far. */
  workers: number[];
  /** Which worker runs each of the part's files. */
  workerOfFile: Map<string, number>;
}

/**
 * Part `index` (1-based) of `count`: `tests` split by their times, the
 * longest first, each to the worker with the least time yet, of every
 * part's `workersPerPart`. A file's tests in one part share a worker
 * (Playwright runs them one after another), so a test whose file already
 * runs in a part goes to that worker there. Returns the part's tests'
 * keys, sorted.
 */
export const partOf = (
  tests: readonly PartTest[],
  durations: Readonly<Record<string, number>>,
  index: number,
  count: number
): string[] => {
  const known = Object.values(durations).toSorted((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 1;
  const secondsOf = (test: PartTest): number => durations[test.key] ?? median;
  const parts = Array.from({ length: count }, (): Part => ({
    keys: [],
    workers: Array.from({ length: workersPerPart }, () => 0),
    workerOfFile: new Map<string, number>(),
  }));
  const longestFirst = tests.toSorted(
    (a, b) => secondsOf(b) - secondsOf(a) || byKey(a.key, b.key)
  );
  for (const test of longestFirst) {
    let best: { part: Part; worker: number } | undefined;
    let bestSeconds = Number.POSITIVE_INFINITY;
    for (const part of parts) {
      const own = part.workerOfFile.get(test.file);
      const workers = own === undefined ? part.workers.keys() : [own];
      for (const worker of workers) {
        const seconds = part.workers[worker] ?? 0;
        if (seconds < bestSeconds) {
          best = { part, worker };
          bestSeconds = seconds;
        }
      }
    }
    if (best !== undefined) {
      best.part.workers[best.worker] = bestSeconds + secondsOf(test);
      best.part.workerOfFile.set(test.file, best.worker);
      best.part.keys.push(test.key);
    }
  }
  return (parts[index - 1]?.keys ?? []).toSorted(byKey);
};

/** The parallel part's Chromium tests, as Playwright lists them. */
const listed = (): PartTest[] =>
  testsIn(
    execFileSync(
      path.join(root, "node_modules/.bin/playwright"),
      ["test", "--list", "--reporter=json", "--project", "chromium"],
      {
        cwd: root,
        encoding: "utf-8",
        env: { ...process.env, GRASP_E2E_PART: "parallel" },
        maxBuffer: 64 * 1024 * 1024,
      }
    )
  );

if (import.meta.main) {
  const match = /^(?<index>\d+)\/(?<count>\d+)$/u.exec(process.argv[2] ?? "");
  const index = Number(match?.groups?.index);
  const count = Number(match?.groups?.count);
  if (index >= 1 && index <= count) {
    const durations = z
      .record(z.string(), z.number())
      .parse(JSON.parse(readFileSync(e2eDurationsFile, "utf-8")));
    console.log(partOf(listed(), durations, index, count).join("\n"));
  } else {
    console.error("Usage: node scripts/e2e-parts.ts <part>/<parts>");
    process.exitCode = 1;
  }
}
