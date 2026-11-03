import { structuredPatch } from "diff";

// How a file's text differs between two versions, as the Code tab's
// Changes show it (app-code.tsx): jsdiff's hunks (`structuredPatch`), a
// few unchanged lines around each change, shaped for the view, with the
// unchanged stretches between hunks left out as gaps.

/** One line of a diff: in both files, only the old one, or only the new. */
export interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
  /** Its number in the old file, from 1; none for an added line. */
  before?: number;
  /** Its number in the new file, from 1; none for a removed line. */
  after?: number;
}

/** A stretch of unchanged lines left out between two shown parts. */
export interface DiffGap {
  kind: "gap";
  lines: number;
}

/** Unchanged lines kept around each change. */
const contextLines = 3;

/** How many lines a file has; its last newline ends a line, not starts one. */
const lineCount = (text: string): number =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/**
 * The changed lines of `before` against `after`, each hunk's unchanged
 * lines around them, and gaps for the unchanged lines between.
 */
export const changedLines = (
  before: string,
  after: string
): (DiffLine | DiffGap)[] => {
  const { hunks } = structuredPatch(
    "",
    "",
    before,
    after,
    undefined,
    undefined,
    {
      context: contextLines,
    }
  );
  const shown: (DiffLine | DiffGap)[] = [];
  // The next old line no hunk has shown yet, from 1.
  let next = 1;
  for (const hunk of hunks) {
    if (hunk.oldStart > next) {
      shown.push({ kind: "gap", lines: hunk.oldStart - next });
    }
    // An empty file's hunk starts at line 0, and has no line of it.
    let old = hunk.oldStart;
    let fresh = hunk.newStart;
    for (const line of hunk.lines) {
      const text = line.slice(1);
      if (line.startsWith("+")) {
        shown.push({ kind: "added", text, after: fresh });
        fresh += 1;
      } else if (line.startsWith("-")) {
        shown.push({ kind: "removed", text, before: old });
        old += 1;
      } else if (line.startsWith(" ")) {
        shown.push({ kind: "same", text, before: old, after: fresh });
        old += 1;
        fresh += 1;
      }
      // "\ No newline at end of file" is no line of either file.
    }
    next = Math.max(old, 1);
  }
  const rest = lineCount(before) - next + 1;
  if (hunks.length > 0 && rest > 0) {
    shown.push({ kind: "gap", lines: rest });
  }
  return shown;
};
