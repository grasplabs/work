// The words agent activity builds from its steps: the one line and the times.
import type { ActivityKind, ActivityStep } from "./types";

/** "0.8s", "14s", "2m 05s". */
export const seconds = (ms: number) => {
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const whole = Math.round(ms / 1000);
  if (whole < 60) {
    return `${whole}s`;
  }
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
};

/** None, one or many, each in its own words: none is never said as 0. */
const sayCount = (
  n: number,
  none: string,
  one: string,
  many: (n: number) => string
) => {
  if (n === 0) {
    return none;
  }
  if (n === 1) {
    return one;
  }
  return many(n);
};

/** A search with no count of what it found is counted as a search: "searched once", "searched 3 times". */
const searchedTimes = (n: number) =>
  sayCount(
    n,
    "did not search",
    "searched once",
    (many) => `searched ${many} times`
  );

// A search with a count of 0 found nothing: "found no sources".
const counted: Record<ActivityKind, (n: number) => string> = {
  search: (n) =>
    sayCount(
      n,
      "found no sources",
      "found 1 source",
      (many) => `found ${many} sources`
    ),
  read: (n) =>
    sayCount(n, "read no files", "read 1 file", (many) => `read ${many} files`),
  write: (n) =>
    sayCount(
      n,
      "changed no files",
      "changed 1 file",
      (many) => `changed ${many} files`
    ),
  tool: (n) =>
    sayCount(n, "ran no tools", "ran 1 tool", (many) => `ran ${many} tools`),
  thought: () => "thought it through",
};
const order: ActivityKind[] = ["search", "read", "write", "tool", "thought"];

/**
 * What one kind of step comes to. A step counts as one thing unless it says how many it touched
 * (`count`): a read of five files is five files. A search is different: the step is a search, not
 * a source, so searches with no count are counted as searches, and once any says how many sources
 * it found, the line says the sources found.
 */
const wordsFor = (kind: ActivityKind, steps: ActivityStep[]) => {
  if (kind === "search" && steps.every((step) => step.count === undefined)) {
    return searchedTimes(steps.length);
  }
  const each = kind === "search" ? 0 : 1;
  return counted[kind](
    steps.reduce((sum, step) => sum + (step.count ?? each), 0)
  );
};

/**
 * "Found 12 sources, read 2 files and changed 1 file", or "Searched 3 times and read 2 files", from
 * the steps that ran: in English, the default of `summarize`.
 */
export const summaryOf = (steps: ActivityStep[]) => {
  const ran = steps.filter(
    (step) => step.state === "done" || step.state === "failed"
  );
  const parts = order
    .map((kind) => [kind, ran.filter((step) => step.kind === kind)] as const)
    .filter(([, of]) => of.length > 0)
    .map(([kind, of]) => wordsFor(kind, of));
  const [only, ...more] = parts;
  if (only === undefined) {
    return "No steps yet";
  }
  const words =
    more.length === 0
      ? only
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
  const failed = steps.filter((step) => step.state === "failed").length;
  const line = words.charAt(0).toUpperCase() + words.slice(1);
  if (failed === 0) {
    return line;
  }
  const count = failed === 1 ? "1 step" : `${failed} steps`;
  return `${line}; ${count} failed`;
};
