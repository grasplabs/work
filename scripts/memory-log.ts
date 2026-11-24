// Logs the runner's memory once a minute, for as long as it runs, beside
// CI's test and e2e steps (.github/workflows/ci.yml):
//
//   node scripts/memory-log.ts &
//
// A runner that runs out of memory can die whole: GitHub then reports only
// that it "received a shutdown signal", and no later step runs to say why
// (seen with #1949, whose workerd ran out of memory in nine runs, read at
// first as runner trouble). The step's own log is all that is kept, so each
// sample goes there: what is available, and which programs hold the most,
// so the climb shows before the end. A sample near the runner's limit says
// "likely out of memory" as a warning, the last thing such a log shows.
import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";

/** A process's program and resident memory, in KiB, as `ps` lists them. */
export interface MemoryRow {
  readonly program: string;
  readonly rssKib: number;
}

const psLine = /^\s*(?<rss>\d+)\s+(?<command>.+?)\s*$/u;

/** The rows of `ps -A -o rss=,comm=`; lines it can't read are skipped. */
export const parseRss = (text: string): MemoryRow[] =>
  text.split("\n").flatMap((line) => {
    const groups = psLine.exec(line)?.groups;
    if (groups === undefined) {
      return [];
    }
    return [
      {
        // macOS's `comm` is a full path, Linux's isn't.
        program: (groups.command ?? "").split("/").at(-1) ?? "",
        rssKib: Number(groups.rss),
      },
    ];
  });

/** How many programs a sample names, the largest first. */
const programsNamed = 4;

/**
 * Below this share of the runner's memory available, a sample warns: the
 * kernel starts killing, or the runner dies, soon after.
 */
export const nearLimitShare = 0.1;

const gibibyte = 1024 ** 3;

const gib = (bytes: number): string => `${(bytes / gibibyte).toFixed(1)} GiB`;

/**
 * One sample as the log shows it: memory available of the runner's, and
 * the programs holding the most, each with how many processes run it; with
 * a warning annotation after it when available memory is near the limit.
 */
export const memorySample = ({
  at,
  availableBytes,
  totalBytes,
  rows,
}: {
  at: Date;
  availableBytes: number;
  totalBytes: number;
  rows: readonly MemoryRow[];
}): string => {
  const byProgram = new Map<string, { bytes: number; count: number }>();
  for (const { program, rssKib } of rows) {
    const seen = byProgram.get(program) ?? { bytes: 0, count: 0 };
    seen.bytes += rssKib * 1024;
    seen.count += 1;
    byProgram.set(program, seen);
  }
  const largest = [...byProgram]
    .toSorted(([a, x], [b, y]) => y.bytes - x.bytes || (a < b ? -1 : 1))
    .slice(0, programsNamed)
    .map(
      ([program, { bytes, count }]) => `${program} ${gib(bytes)} (${count})`
    );
  const line = `[memory ${at.toISOString().slice(11, 19)}] ${gib(availableBytes)} available of ${gib(totalBytes)}; most held by ${largest.join(", ") || "nothing listed"}`;
  if (availableBytes >= totalBytes * nearLimitShare) {
    return `${line}\n`;
  }
  return `${line}\n::warning title=memory::Only ${gib(availableBytes)} of ${gib(totalBytes)} is available: if the runner stops after this (a shutdown signal), it likely ran out of memory.\n`;
};

/** How often a sample is taken. */
const sampleMs = 60 * 1000;

const sample = (): void => {
  let rows: MemoryRow[] = [];
  try {
    rows = parseRss(
      execFileSync("ps", ["-A", "-o", "rss=,comm="], {
        encoding: "utf-8",
        timeout: 5000,
      })
    );
  } catch {
    // Without `ps`, the sample still says what is available.
  }
  process.stdout.write(
    memorySample({
      at: new Date(),
      availableBytes: freemem(),
      totalBytes: totalmem(),
      rows,
    })
  );
};

if (import.meta.main) {
  sample();
  setInterval(sample, sampleMs);
}
