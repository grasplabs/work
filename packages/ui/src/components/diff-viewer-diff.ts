// The line diff of DiffViewer (diff-viewer.tsx), pure, with no StyleX, so the server draws the same
// rows as the browser and the model is tested without a page. The diffs themselves are jsdiff's
// (the npm `diff` package): lines, words with their spaces (within a changed line) and words
// (prose). This file is the model on top: what changed
// between two texts, as lines with their numbers, changes made of removed and added lines, the words
// that changed inside a line, and the runs of unchanged lines that fold away.
import { diffLines, diffWords, diffWordsWithSpace } from "diff";

export type LineKind = "same" | "added" | "removed";

/** A run of a line's text, marked when it is what changed within the line. */
export interface Piece {
  text: string;
  changed: boolean;
}

export interface Line {
  kind: LineKind;
  /** Its number in the text before, for a line that was there. */
  oldNo?: number;
  /** Its number in the text after, for a line that is there. */
  newNo?: number;
  text: string;
  /** The line in pieces, when a removed line and an added one pair up as one line changed. */
  pieces?: Piece[];
  /** The change it belongs to, counting from 0. */
  change?: number;
}

/**
 * The longest line's length, a tab as two characters. A loop, not `Math.max(...lines)`: an engine
 * caps a call's arguments (Safari at 65,536), and a long diff has more lines than that.
 */
export const longestLine = (lines: readonly Line[]) => {
  let longest = 0;
  for (const line of lines) {
    longest = Math.max(longest, line.text.replaceAll("\t", "  ").length);
  }
  return longest;
};

/** The highest line number, before or after, at least 1: how many digits the gutter holds. */
export const highestNumber = (lines: readonly Line[]) => {
  let highest = 1;
  for (const line of lines) {
    highest = Math.max(highest, line.oldNo ?? 0, line.newNo ?? 0);
  }
  return highest;
};

/** One change: a run of removed lines, then the added ones that replace them. */
export interface Change {
  index: number;
  /** Where it starts among the lines. */
  first: number;
  /** Where it ends among the lines, the last one included. */
  last: number;
  removed: number;
  added: number;
}

/** A row to draw in the unified form. */
/** A hunk's place in both texts, as git writes it: `@@ -oldStart,oldCount +newStart,newCount @@`. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export type Row =
  | { type: "line"; key: string; line: Line }
  | { type: "fold"; key: string; from: number; count: number }
  | { type: "head"; key: string; change: Change }
  | ({
      type: "hunk";
      key: string;
      /** The unchanged run folded just before it: its head holds the control that opens it. */
      fold?: { key: string; from: number; count: number };
    } & Hunk);

/** A row to draw side by side: the line before on the left, after on the right. */
export type SplitRow =
  | { type: "pair"; key: string; left?: Line; right?: Line }
  | { type: "fold"; key: string; from: number; count: number }
  | { type: "head"; key: string; change: Change };

/** Splits a text into its lines, without the empty one after a final line break. */
const linesOf = (value: string) => {
  const lines = value.replaceAll(/\r$/gmu, "").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
};

/** How alike two lines are, from 0 to 1: the share of their characters left unchanged. */
const likeness = (a: string, b: string) => {
  const longest = Math.max(a.trim().length, b.trim().length);
  if (longest === 0) {
    return 1;
  }
  const kept = diffWordsWithSpace(a, b)
    .filter((part) => !part.added && !part.removed)
    .reduce((sum, part) => sum + part.value.trim().length, 0);
  return kept / longest;
};

/** Lines this alike are one line changed; less alike, one line out and another in. */
const ALIKE = 0.5;

/**
 * In an even block (as many lines out as in), the line in the same place needs less: a tag or a call
 * whose words changed keeps only its marks ("<h1>Expenses</h1>" to "<h1>Open expenses</h1>").
 */
const ALIKE_IN_PLACE = 0.3;

/** How far ahead a removed line looks for its pair, so a rewritten file stays fast. */
const REACH = 8;

/** Past this many removed lines a change is a rewrite, not lines edited: no words are marked. */
const REWRITE = 400;

/** Marks the words that changed between a removed line and the added line that replaced it. */
const pairWords = (removed: Line, added: Line) => {
  const parts = diffWordsWithSpace(removed.text, added.text);
  removed.pieces = parts
    .filter((part) => !part.added)
    .map((part) => ({ text: part.value, changed: part.removed }));
  added.pieces = parts
    .filter((part) => !part.removed)
    .map((part) => ({ text: part.value, changed: part.added }));
};

/**
 * Pairs each removed line with the added line most like it, in order, so the words are marked
 * against the line that really replaced it, not merely the one in the same place.
 */
const pairBlock = (removed: Line[], added: Line[]) => {
  if (removed.length > REWRITE) {
    return;
  }
  let from = 0;
  const even = removed.length === added.length;
  for (const [index, out] of removed.entries()) {
    let best: Line | undefined;
    let bestAt = -1;
    let score = -1;
    for (let at = from; at < Math.min(added.length, from + REACH); at += 1) {
      const candidate = added[at];
      if (candidate === undefined) {
        continue;
      }
      const bar = even && at === index ? ALIKE_IN_PLACE : ALIKE;
      // Lines of very different lengths are not one line changed: skip the costly comparison.
      const longer = Math.max(out.text.length, candidate.text.length);
      if (
        longer > 0 &&
        Math.min(out.text.length, candidate.text.length) / longer < bar
      ) {
        continue;
      }
      const alike = likeness(out.text, candidate.text);
      // The earlier line wins a tie, so later pairs keep their chance.
      if (alike >= bar && alike > score) {
        best = candidate;
        bestAt = at;
        score = alike;
      }
    }
    if (best !== undefined) {
      pairWords(out, best);
      from = bestAt + 1;
    }
  }
};

/** Every line of the two texts in order, numbered, with the changes they make. */
export const compare = (before: string, after: string) => {
  const lines: Line[] = [];
  let oldNo = 0;
  let newNo = 0;
  // Line endings are not a change a person reads: a missing last newline and CRLF against LF
  // would otherwise show lines changed with nothing visible.
  // A file rewritten end to end would take seconds to diff line by line; past 300ms it
  // reads as the old lines out and the new lines in, which is what a person sees anyway.
  const parts = diffLines(before, after, {
    stripTrailingCr: true,
    ignoreNewlineAtEof: true,
    timeout: 300,
  }) ?? [
    { value: before, removed: true, added: false, count: 0 },
    { value: after, added: true, removed: false, count: 0 },
  ];
  for (const part of parts) {
    for (const text of linesOf(part.value)) {
      if (part.added) {
        newNo += 1;
        lines.push({ kind: "added", newNo, text });
      } else if (part.removed) {
        oldNo += 1;
        lines.push({ kind: "removed", oldNo, text });
      } else {
        oldNo += 1;
        newNo += 1;
        lines.push({ kind: "same", oldNo, newNo, text });
      }
    }
  }
  const changes: Change[] = [];
  for (let at = 0; at < lines.length;) {
    if (lines[at]?.kind === "same") {
      at += 1;
      continue;
    }
    const first = at;
    while (at < lines.length && lines[at]?.kind !== "same") {
      at += 1;
    }
    const block = lines.slice(first, at);
    const removed = block.filter((line) => line.kind === "removed");
    const added = block.filter((line) => line.kind === "added");
    // A removed line and the added line most like it are one line changed: mark its words.
    pairBlock(removed, added);
    const index = changes.length;
    for (const line of block) {
      line.change = index;
    }
    changes.push({
      index,
      first,
      last: at - 1,
      removed: removed.length,
      added: added.length,
    });
  }
  return { lines, changes };
};

/**
 * Which unchanged lines fold away: those further than `context` lines from any change, in runs.
 * A run is shown again when its key is in `open`. Returns the runs by their first line.
 */
export const foldsOf = (
  lines: readonly Line[],
  changes: readonly Change[],
  context: number,
  open: { has: (key: string) => boolean }
) => {
  const near = Array.from({ length: lines.length }, () => false);
  for (const change of changes) {
    for (
      let at = Math.max(0, change.first - context);
      at <= Math.min(lines.length - 1, change.last + context);
      at += 1
    ) {
      near[at] = true;
    }
  }
  const folds = new Map<number, number>();
  for (let at = 0; at < lines.length;) {
    if (near[at] === true || lines[at]?.kind !== "same") {
      at += 1;
      continue;
    }
    const from = at;
    while (
      at < lines.length &&
      near[at] !== true &&
      lines[at]?.kind === "same"
    ) {
      at += 1;
    }
    // A single line is shown, not folded: "Show 1 unchanged line" would take the same room.
    if (at - from > 1 && !open.has(`fold-${from}`)) {
      folds.set(from, at - from);
    }
  }
  return folds;
};

/** The last number on one side before `from`: where a hunk with no lines on that side stands. */
const numberBefore = (
  lines: readonly Line[],
  from: number,
  side: "oldNo" | "newNo"
) => {
  for (let at = from - 1; at >= 0; at -= 1) {
    const number = lines[at]?.[side];
    if (number !== undefined) {
      return number;
    }
  }
  return 0;
};

/**
 * The hunk of the lines from `from` up to `to` (not included): where it starts and how many lines it
 * has in each text. A side with no lines starts at the line before it, as git writes it
 * (`@@ -0,0 +1,3 @@` for a new file).
 */
export const hunkOf = (
  lines: readonly Line[],
  from: number,
  to: number
): Hunk => {
  const run = lines.slice(from, to);
  const olds = run.filter((line) => line.oldNo !== undefined);
  const news = run.filter((line) => line.newNo !== undefined);
  return {
    oldStart: olds[0]?.oldNo ?? numberBefore(lines, from, "oldNo"),
    oldCount: olds.length,
    newStart: news[0]?.newNo ?? numberBefore(lines, from, "newNo"),
    newCount: news.length,
  };
};

/** Where the run of shown lines starting at `from` ends: at the next fold, or the last line. */
const runEnd = (
  lines: readonly Line[],
  folds: ReadonlyMap<number, number>,
  from: number
) => {
  let at = from;
  while (at < lines.length && !folds.has(at)) {
    at += 1;
  }
  return at;
};

/** A hunk's range on one side, as git writes it: the count left out when it is 1. */
export const rangeOf = (start: number, count: number) =>
  count === 1 ? String(start) : `${start},${count}`;

/** A hunk's head as git writes it: "@@ -12,7 +12,8 @@". */
export const hunkHead = (hunk: Hunk) =>
  `@@ -${rangeOf(hunk.oldStart, hunk.oldCount)} +${rangeOf(hunk.newStart, hunk.newCount)} @@`;

/**
 * The unified rows: lines, the folds between them, a head before each change when reviewing, and
 * with `hunks` a hunk's head before each run of shown lines.
 */
export const unifiedRows = (
  lines: readonly Line[],
  changes: readonly Change[],
  folds: ReadonlyMap<number, number>,
  heads: boolean,
  hunks = false
): Row[] => {
  const rows: Row[] = [];
  let runStarts = true;
  // With hunks, a fold before a hunk is no row of its own: the hunk's head holds its control.
  let held: { key: string; from: number; count: number } | undefined;
  for (let at = 0; at < lines.length;) {
    const count = folds.get(at);
    const line = lines[at];
    if (count !== undefined) {
      const fold = { key: `fold-${at}`, from: at, count };
      if (hunks && at + count < lines.length) {
        held = fold;
      } else {
        rows.push({ type: "fold", ...fold });
      }
      at += count;
      runStarts = true;
    } else if (line === undefined) {
      at += 1;
    } else {
      if (hunks && runStarts) {
        rows.push({
          type: "hunk",
          key: `hunk-${at}`,
          fold: held,
          ...hunkOf(lines, at, runEnd(lines, folds, at)),
        });
        held = undefined;
      }
      runStarts = false;
      const change =
        line.change === undefined ? undefined : changes[line.change];
      if (heads && change?.first === at) {
        rows.push({ type: "head", key: `head-${change.index}`, change });
      }
      rows.push({ type: "line", key: `line-${at}`, line });
      at += 1;
    }
  }
  return rows;
};

/** The side-by-side rows: unchanged lines on both sides, a change's removed lines beside its added. */
export const splitRows = (
  lines: readonly Line[],
  changes: readonly Change[],
  folds: ReadonlyMap<number, number>,
  heads: boolean
): SplitRow[] => {
  const rows: SplitRow[] = [];
  for (let at = 0; at < lines.length;) {
    const count = folds.get(at);
    const line = lines[at];
    const change =
      line?.change === undefined ? undefined : changes[line.change];
    if (count !== undefined) {
      rows.push({ type: "fold", key: `fold-${at}`, from: at, count });
      at += count;
    } else if (line === undefined || change === undefined) {
      // An unchanged line stands on both sides.
      if (line !== undefined) {
        rows.push({ type: "pair", key: `pair-${at}`, left: line, right: line });
      }
      at += 1;
    } else {
      if (heads) {
        rows.push({ type: "head", key: `head-${change.index}`, change });
      }
      const block = lines.slice(change.first, change.last + 1);
      const removed = block.filter((each) => each.kind === "removed");
      const added = block.filter((each) => each.kind === "added");
      for (
        let pair = 0;
        pair < Math.max(removed.length, added.length);
        pair += 1
      ) {
        rows.push({
          type: "pair",
          key: `pair-${change.first}-${pair}`,
          left: removed[pair],
          right: added[pair],
        });
      }
      at = change.last + 1;
    }
  }
  return rows;
};

/** A piece of prose, as it reads after, with what was taken out and put in marked. */
export interface ProsePiece {
  text: string;
  kind: "same" | "added" | "removed";
}

const kindOf = (part: {
  added?: boolean;
  removed?: boolean;
}): ProsePiece["kind"] => {
  if (part.added === true) {
    return "added";
  }
  return part.removed === true ? "removed" : "same";
};

/** Prose, word by word: what was taken out and put in, in the flow of the text. */
export const prose = (before: string, after: string): ProsePiece[] =>
  diffWords(before, after).map((part) => ({
    text: part.value,
    kind: kindOf(part),
  }));
