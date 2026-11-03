import type { FileDiff } from "@grasp-os/shared/apps";
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

/**
 * That the line above it is the last of its file, with no newline after
 * it: jsdiff's `\ No newline at end of file`. Without it, a change of the
 * final newline alone shows the same line removed and added.
 */
export interface DiffNoNewline {
  kind: "no-newline";
}

/** What the view shows of a file's change, in order. */
export type DiffPart = DiffLine | DiffGap | DiffNoNewline;

/** Unchanged lines kept around each change. */
const contextLines = 3;

/** A file's lines; its last newline ends a line, not starts one. */
const linesOf = (text: string): string[] => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
};

/**
 * The most lines added and removed worked out for one modified file. The
 * diff runs on the page's own thread, for each changed file of a draft:
 * past this, a file's change costs more than it shows, and it isn't
 * worked out.
 */
const maxEditLength = 2000;

/**
 * How a file changed: an added file's lines all added, a deleted file's
 * all removed, with nothing to compare; a modified file's changed lines,
 * each hunk's unchanged lines around them and gaps for the unchanged
 * lines between, or none when it changes more lines than `maxEditLength`.
 */
export const changedLines = (diff: FileDiff): DiffPart[] | undefined => {
  if (diff.change === "added") {
    return linesOf(diff.after).map((text, index) => ({
      kind: "added",
      text,
      after: index + 1,
    }));
  }
  if (diff.change === "deleted") {
    return linesOf(diff.before).map((text, index) => ({
      kind: "removed",
      text,
      before: index + 1,
    }));
  }
  const { before, after } = diff;
  const patch = structuredPatch("", "", before, after, undefined, undefined, {
    context: contextLines,
    maxEditLength,
  });
  if (patch === undefined) {
    return undefined;
  }
  const { hunks } = patch;
  const shown: DiffPart[] = [];
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
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file", of the line before it.
        shown.push({ kind: "no-newline" });
      }
    }
    next = Math.max(old, 1);
  }
  const rest = linesOf(before).length - next + 1;
  if (hunks.length > 0 && rest > 0) {
    shown.push({ kind: "gap", lines: rest });
  }
  return shown;
};
