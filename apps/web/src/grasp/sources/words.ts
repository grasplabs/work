// Sources' own words, in English, for Sources, Citation and SourceList. The product gives them in its
// languages through GraspWords (src/words); a caller's `labels` and SourceList's `heading` still win
// until the breaking release's step 5. A word with a number or a kind in it is a function.
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

export const sourcesWords = {
  ...englishLabels,
  /** SourceList's heading (`heading`). */
  heading: "Sources",
};

export type SourcesWords = typeof sourcesWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    sources: SourcesWords;
  }
}
