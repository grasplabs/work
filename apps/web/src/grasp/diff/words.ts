// Diff's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `words` and `aria-label` still win until the breaking release's step 5.
import type { DiffWords } from "./diff";

/** How much changed, in words: "2 removed, 3 added". */
const sizesOf = (removed: number, added: number) =>
  [removed > 0 ? `${removed} removed` : "", added > 0 ? `${added} added` : ""]
    .filter((each) => each !== "")
    .join(", ");

/** A hunk's lines on one side, in English: "lines 12 to 18", "line 4", "no lines". */
const englishLines = (start: number, count: number) => {
  // A side starts at 0 only when it has no lines (git's "-0,0").
  if (count === 0 || start === 0) {
    return "no lines";
  }
  return count === 1
    ? `line ${start}`
    : `lines ${start} to ${start + count - 1}`;
};

const ownWords: DiffWords = {
  accept: "Accept",
  reject: "Reject",
  undo: "Undo",
  accepted: "Accepted",
  rejected: "Rejected",
  added: "Added",
  removed: "Removed",
  before: "Before",
  after: "After",
  lineBefore: "Line before",
  lineAfter: "Line after",
  change: "Change",
  text: "Text",
  nothing: "Nothing changed.",
  same: "Nothing changed: both are the same.",
  unchanged: (count) => `Show ${count} unchanged lines`,
  changeOf: (at, of, removed, added) =>
    `Change ${at} of ${of}: ${sizesOf(removed, added)}`,
  counts: (added, removed) =>
    `${added === 0 ? "No" : added} ${added === 1 ? "line" : "lines"} added, ${removed === 0 ? "none" : removed} removed`,
  said: (at, decision) =>
    decision === null
      ? `Change ${at} back to undecided`
      : `Change ${at} ${decision}`,
  lines: (name) => `${name}, lines`,
  hunk: (oldStart, oldCount, newStart, newCount) => {
    const before = englishLines(oldStart, oldCount);
    return `${before.charAt(0).toUpperCase()}${before.slice(1)} before, ${englishLines(newStart, newCount)} after`;
  },
};

/** Its words in the catalogue: its own, and its name when the caller gives none. */
export const diffWords = { ...ownWords, name: "Changes" };

export type DiffCatalogueWords = typeof diffWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    diff: DiffCatalogueWords;
  }
}
