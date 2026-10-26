// Which e2e files a CI part runs, of the parallel part's (playwright.config.ts):
//
//   vp run e2e $(node scripts/e2e-parts.ts 3/8)
//
// Split by how long each file takes (scripts/e2e-durations.json), as the
// test shards are (scripts/test-shards.ts). Playwright's own `--shard`
// splits by test count, in file order, so one part held the slowest
// files and took twice as long as another (October 2026, GRA-1094). A
// file nobody timed yet is taken to take the median file's time. Prints
// a filter per file, each matching that file's path only.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  interviewTests,
  journeyTests,
  onboardingTests,
} from "../playwright.config.ts";
import { byKey } from "./test-shards.ts";

const root = path.join(import.meta.dirname, "..");

/** Where the e2e files' times are kept: seconds per `e2e/<file>`. */
export const e2eDurationsFile = fileURLToPath(
  new URL("e2e-durations.json", import.meta.url)
);

/** The parallel part's files: the serial projects' and the admin's run apart. */
export const parallelFiles = (names: readonly string[]): string[] =>
  names
    .filter((name) => name.endsWith(".e2e.ts"))
    .map((name) => `e2e/${name}`)
    .filter(
      (file) =>
        ![onboardingTests, interviewTests, journeyTests].some((serial) =>
          serial.test(file)
        )
    )
    .toSorted(byKey);

/**
 * Part `index` (1-based) of `count`: `files` split by their times, the
 * longest first, each into the part with the least time yet. A part's two
 * workers share its files, and the longest files run their tests on both
 * (`mode: "parallel"`), so a part takes about half its files' time.
 */
export const partOf = (
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
  index: number,
  count: number
): string[] => {
  const known = Object.values(durations).toSorted((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 1;
  const secondsOf = (file: string): number => durations[file] ?? median;
  const parts: { seconds: number; files: string[] }[] = Array.from(
    { length: count },
    () => ({ seconds: 0, files: [] })
  );
  const longestFirst = files.toSorted(
    (a, b) => secondsOf(b) - secondsOf(a) || byKey(a, b)
  );
  for (const file of longestFirst) {
    let [least] = parts;
    for (const part of parts) {
      if (least === undefined || part.seconds < least.seconds) {
        least = part;
      }
    }
    if (least !== undefined) {
      least.seconds += secondsOf(file);
      least.files.push(file);
    }
  }
  return (parts[index - 1]?.files ?? []).toSorted(byKey);
};

/** A Playwright file filter, a regular expression, that matches `file` only. */
export const filterOf = (file: string): string =>
  `/${file.replaceAll(".", String.raw`\.`)}$`;

if (import.meta.main) {
  const match = /^(?<index>\d+)\/(?<count>\d+)$/u.exec(process.argv[2] ?? "");
  const index = Number(match?.groups?.index);
  const count = Number(match?.groups?.count);
  if (index >= 1 && index <= count) {
    const durations = z
      .record(z.string(), z.number())
      .parse(JSON.parse(readFileSync(e2eDurationsFile, "utf-8")));
    const files = parallelFiles(readdirSync(path.join(root, "e2e")));
    console.log(partOf(files, durations, index, count).map(filterOf).join(" "));
  } else {
    console.error("Usage: node scripts/e2e-parts.ts <part>/<parts>");
    process.exitCode = 1;
  }
}
