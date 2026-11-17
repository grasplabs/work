// The words Sources shows and says, in English. A product passes its own words through `labels`; any it leaves out are these.
import type { SourceKind, SourcesLabels } from "./types";

const nth = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];

const kindWords: Record<SourceKind, readonly [string, string]> = {
  file: ["file", "files"],
  web: ["page", "pages"],
  record: ["record", "records"],
  message: ["message", "messages"],
  meeting: ["meeting", "meetings"],
  person: ["person", "people"],
  agent: ["agent", "agents"],
  workflow: ["workflow", "workflows"],
  table: ["table", "tables"],
  memory: ["memory", "memories"],
  code: ["code file", "code files"],
};

export const englishLabels: SourcesLabels = {
  source: (number) => `Source ${number}`,
  mention: (index) =>
    `${nth[index - 1] ?? `mention ${index}`}${index <= nth.length ? " mention" : ""}`,
  gone: "Could not be opened",
  locked: "You cannot open this",
  goneInName: "could not be opened",
  lockedInName: "you cannot open it",
  // None is said in words: "No sources", "No files".
  count: (count) =>
    count === 0
      ? "No sources"
      : `${count} ${count === 1 ? "source" : "sources"}`,
  kind: (kind, count) =>
    `${count === 0 ? "No" : count} ${kindWords[kind][count === 1 ? 0 : 1]}`,
  showMore: (count) => `Show ${count} more`,
  showFewer: "Show fewer",
  order: "Order",
  byRelevance: "By relevance",
  byKind: "By kind",
  open: "Show them",
  close: "Fold them away",
  openRun: "Open the run",
  correct: "Correct it",
};

/** The kinds in a list, most first, each with its number: ["4 files", "3 messages"]. */
export const kindsInParts = (
  kinds: readonly SourceKind[],
  labels: SourcesLabels
) => {
  const counts = new Map<SourceKind, number>();
  for (const kind of kinds) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([kind, count]) => labels.kind(kind, count));
};
