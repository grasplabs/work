// The line diff of DiffViewer (diff-viewer.tsx), pure, with no StyleX, so the server draws the same
// rows as the browser and the engine is checked without a page (scripts/check-diff-engine.ts).
// Adapted from jsdiff (BSD-3-Clause), see THIRD_PARTY_NOTICES.md.
//
// Two halves. The engine, in place of the npm `diff` package: the three diffs the part uses, lines,
// words with their spaces (within a changed line), and words (prose). It follows jsdiff 9.0.0 step
// for step (Myers' O(ND) diff, with its choice of path on a tie, its tokens and its whitespace
// tidying for words), so it draws every diff as jsdiff would; jsdiff is
// BSD-3-Clause, Copyright (c) 2009-2015, Kevin Decker, and this is a rewrite of the parts the part
// uses, not a copy of its files. Then the model: what changed between two texts, as lines with
// their numbers, changes made of removed and added lines, the words that changed inside a line, and
// the runs of unchanged lines that fold away.

// ---- The engine ----------------------------------------------------------------------------------

/** A run of the texts: the same in both, taken out of the first, or put into the second. */
export interface DiffPart {
  value: string;
  added: boolean;
  removed: boolean;
  /** How many tokens it holds. */
  count: number;
}

interface Component {
  count: number;
  added: boolean;
  removed: boolean;
  previous: Component | undefined;
}

interface Path {
  oldPos: number;
  last: Component | undefined;
}

interface Engine {
  equals: (left: string, right: string) => boolean;
  join: (tokens: readonly string[]) => string;
}

/** A path one step on: an insertion or a removal, joined to the run before when it is the same kind. */
const step = (
  path: Path,
  added: boolean,
  removed: boolean,
  oldPosInc: number
): Path => {
  const { last } = path;
  if (last !== undefined && last.added === added && last.removed === removed) {
    return {
      oldPos: path.oldPos + oldPosInc,
      last: { count: last.count + 1, added, removed, previous: last.previous },
    };
  }
  return {
    oldPos: path.oldPos + oldPosInc,
    last: { count: 1, added, removed, previous: last },
  };
};

/** Follows a diagonal while the tokens are the same; gives the new position reached. */
const slide = (
  path: Path,
  newTokens: readonly string[],
  oldTokens: readonly string[],
  diagonal: number,
  engine: Engine
) => {
  let { oldPos } = path;
  let newPos = oldPos - diagonal;
  let common = 0;
  while (
    newPos + 1 < newTokens.length &&
    oldPos + 1 < oldTokens.length &&
    engine.equals(oldTokens[oldPos + 1] ?? "", newTokens[newPos + 1] ?? "")
  ) {
    newPos += 1;
    oldPos += 1;
    common += 1;
  }
  if (common > 0) {
    path.last = {
      count: common,
      added: false,
      removed: false,
      previous: path.last,
    };
  }
  path.oldPos = oldPos;
  return newPos;
};

/** The runs, first to last, with their text. */
const valuesOf = (
  last: Component | undefined,
  newTokens: readonly string[],
  oldTokens: readonly string[],
  engine: Engine
): DiffPart[] => {
  const components: Component[] = [];
  for (let at = last; at !== undefined; at = at.previous) {
    components.push(at);
  }
  let newPos = 0;
  let oldPos = 0;
  return components.toReversed().map((component) => {
    if (component.removed) {
      const value = engine.join(
        oldTokens.slice(oldPos, oldPos + component.count)
      );
      oldPos += component.count;
      return { value, added: false, removed: true, count: component.count };
    }
    const value = engine.join(
      newTokens.slice(newPos, newPos + component.count)
    );
    newPos += component.count;
    if (!component.added) {
      oldPos += component.count;
    }
    return {
      value,
      added: component.added,
      removed: false,
      count: component.count,
    };
  });
};

/** One round of the search: every diagonal reachable with this many edits. Gives the runs when done. */
const round = (
  state: {
    best: (Path | undefined)[];
    edits: number;
    minDiagonal: number;
    maxDiagonal: number;
  },
  newTokens: readonly string[],
  oldTokens: readonly string[],
  engine: Engine
): DiffPart[] | undefined => {
  const offset = oldTokens.length + newTokens.length + 1;
  for (
    let diagonal = Math.max(state.minDiagonal, -state.edits);
    diagonal <= Math.min(state.maxDiagonal, state.edits);
    diagonal += 2
  ) {
    const removePath = state.best[offset + diagonal - 1];
    const addPath = state.best[offset + diagonal + 1];
    if (removePath !== undefined) {
      state.best[offset + diagonal - 1] = undefined;
    }
    const addNewPos = addPath === undefined ? -1 : addPath.oldPos - diagonal;
    const canAdd =
      addPath !== undefined && addNewPos >= 0 && addNewPos < newTokens.length;
    const canRemove =
      removePath !== undefined && removePath.oldPos + 1 < oldTokens.length;
    if (!canAdd && !canRemove) {
      state.best[offset + diagonal] = undefined;
      continue;
    }
    // From the path furthest along the old text that stays inside the graph.
    const base =
      addPath !== undefined &&
      (!canRemove || (canAdd && (removePath?.oldPos ?? -1) < addPath.oldPos))
        ? step(addPath, true, false, 0)
        : step(removePath ?? { oldPos: -1, last: undefined }, false, true, 1);
    const newPos = slide(base, newTokens, oldTokens, diagonal, engine);
    if (base.oldPos + 1 >= oldTokens.length && newPos + 1 >= newTokens.length) {
      return valuesOf(base.last, newTokens, oldTokens, engine);
    }
    state.best[offset + diagonal] = base;
    if (base.oldPos + 1 >= oldTokens.length) {
      state.maxDiagonal = Math.min(state.maxDiagonal, diagonal - 1);
    }
    if (newPos + 1 >= newTokens.length) {
      state.minDiagonal = Math.max(state.minDiagonal, diagonal + 1);
    }
  }
  state.edits += 1;
  return undefined;
};

/** The shortest edit from one list of tokens to the other, or `undefined` past `timeout` ms. */
const diffTokens = (
  oldTokens: readonly string[],
  newTokens: readonly string[],
  engine: Engine,
  timeout = Number.POSITIVE_INFINITY
): DiffPart[] | undefined => {
  const first: Path = { oldPos: -1, last: undefined };
  const newPos = slide(first, newTokens, oldTokens, 0, engine);
  if (first.oldPos + 1 >= oldTokens.length && newPos + 1 >= newTokens.length) {
    return valuesOf(first.last, newTokens, oldTokens, engine);
  }
  const offset = oldTokens.length + newTokens.length + 1;
  const best: (Path | undefined)[] = [];
  best[offset] = first;
  const state = {
    best,
    edits: 1,
    minDiagonal: Number.NEGATIVE_INFINITY,
    maxDiagonal: Number.POSITIVE_INFINITY,
  };
  const stopAt = Date.now() + timeout;
  while (
    state.edits <= oldTokens.length + newTokens.length &&
    Date.now() <= stopAt
  ) {
    const done = round(state, newTokens, oldTokens, engine);
    if (done !== undefined) {
      return done;
    }
  }
  return undefined;
};

const plain = (tokens: readonly string[]) => tokens.join("");

// ---- Lines

/** A text's lines, each with its line break; CRLF read as LF. */
const lineTokensOf = (value: string) => {
  const parts = value.replaceAll("\r\n", "\n").split(/(?<end>\n|\r\n)/u);
  if (parts.at(-1) === "") {
    parts.pop();
  }
  const lines: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1) {
      lines[lines.length - 1] = `${lines.at(-1) ?? ""}${part}`;
    } else {
      lines.push(part);
    }
  }
  return lines;
};

/** A line without the break it ends on: a missing break at the end is no change. */
const bare = (line: string) => (line.endsWith("\n") ? line.slice(0, -1) : line);

/**
 * Line by line, as jsdiff's `diffLines` with `stripTrailingCr` and `ignoreNewlineAtEof`: CRLF is LF,
 * and the last line's break, there or not, is no change. `undefined` past `timeout` ms.
 */
export const diffLines = (before: string, after: string, timeout?: number) =>
  diffTokens(
    lineTokensOf(before).filter((line) => line !== ""),
    lineTokensOf(after).filter((line) => line !== ""),
    { equals: (left, right) => bare(left) === bare(right), join: plain },
    timeout
  );

// ---- Words

// The letters a word is made of: ASCII letters and digits, the underscore, the soft hyphen and the
// Latin letters with marks (jsdiff's own set, for the same tokens).
const WORD =
  "a-zA-Z0-9_\\u{AD}\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}";
const WITH_SPACE = new RegExp(
  `(\\r?\\n)|[${WORD}]+|[^\\S\\n\\r]+|[^${WORD}]`,
  "gu"
);
const RUNS = new RegExp(`[${WORD}]+|\\s+|[^${WORD}]`, "gu");
const SPACE = /\s/u;

/** Word by word, the spaces their own tokens and each line break its own, as jsdiff's `diffWordsWithSpace`. */
export const diffWordsWithSpace = (before: string, after: string) =>
  diffTokens(before.match(WITH_SPACE) ?? [], after.match(WITH_SPACE) ?? [], {
    equals: (left, right) => left === right,
    join: plain,
  }) ?? [];

/** Words and marks, each holding the spaces around it. */
const wordsOf = (value: string) => {
  const tokens: string[] = [];
  let previous: string | undefined;
  for (const part of value.match(RUNS) ?? []) {
    if (SPACE.test(part)) {
      tokens.push(
        previous === undefined ? part : `${tokens.pop() ?? ""}${part}`
      );
    } else if (previous !== undefined && SPACE.test(previous)) {
      tokens.push(
        tokens.at(-1) === previous
          ? `${tokens.pop() ?? ""}${part}`
          : `${previous}${part}`
      );
    } else {
      tokens.push(part);
    }
    previous = part;
  }
  return tokens;
};

/** Tokens that stood together, joined: each one's leading spaces are the one before's trailing. */
const joinWords = (tokens: readonly string[]) =>
  tokens
    .map((token, index) => (index === 0 ? token : token.replace(/^\s+/u, "")))
    .join("");

const leadingWs = (value: string) => /^\s*/u.exec(value)?.[0] ?? "";
const trailingWs = (value: string) => {
  let at = value.length;
  while (at > 0 && SPACE.test(value[at - 1] ?? "")) {
    at -= 1;
  }
  return value.slice(at);
};

const commonPrefix = (a: string, b: string) => {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) {
    at += 1;
  }
  return a.slice(0, at);
};

const commonSuffix = (a: string, b: string) => {
  let at = 0;
  while (
    at < a.length &&
    at < b.length &&
    a[a.length - 1 - at] === b[b.length - 1 - at]
  ) {
    at += 1;
  }
  return at === 0 ? "" : a.slice(-at);
};

const withoutPrefix = (value: string, prefix: string) =>
  value.slice(prefix.length);
const withoutSuffix = (value: string, suffix: string) =>
  suffix === "" ? value : value.slice(0, -suffix.length);
const swapPrefix = (value: string, prefix: string, next: string) =>
  `${next}${value.slice(prefix.length)}`;
const swapSuffix = (value: string, suffix: string, next: string) =>
  `${withoutSuffix(value, suffix)}${next}`;

/** The longest end of `a` that `b` starts with. */
const overlap = (a: string, b: string) => {
  for (let length = Math.min(a.length, b.length); length > 0; length -= 1) {
    if (a.endsWith(b.slice(0, length))) {
      return b.slice(0, length);
    }
  }
  return "";
};

/** A run taken out with nothing put in its place: its spaces, against the runs kept round it. */
const tidyDeletion = (
  startKeep: DiffPart | undefined,
  deletion: DiffPart,
  endKeep: DiffPart | undefined
) => {
  if (startKeep !== undefined && endKeep !== undefined) {
    const newFull = leadingWs(endKeep.value);
    const newStart = commonPrefix(newFull, leadingWs(deletion.value));
    deletion.value = withoutPrefix(deletion.value, newStart);
    const newEnd = commonSuffix(
      withoutPrefix(newFull, newStart),
      trailingWs(deletion.value)
    );
    deletion.value = withoutSuffix(deletion.value, newEnd);
    endKeep.value = swapPrefix(endKeep.value, newFull, newEnd);
    startKeep.value = swapSuffix(
      startKeep.value,
      newFull,
      newFull.slice(0, newFull.length - newEnd.length)
    );
  } else if (endKeep !== undefined) {
    deletion.value = withoutSuffix(
      deletion.value,
      overlap(trailingWs(deletion.value), leadingWs(endKeep.value))
    );
  } else if (startKeep !== undefined) {
    deletion.value = withoutPrefix(
      deletion.value,
      overlap(trailingWs(startKeep.value), leadingWs(deletion.value))
    );
  }
};

/**
 * Tidies the spaces between a run kept, what was taken out and put in, and the next run kept, so a
 * space is not said twice (jsdiff's own tidying, case by case).
 */
const tidy = (
  startKeep: DiffPart | undefined,
  deletion: DiffPart | undefined,
  insertion: DiffPart | undefined,
  endKeep?: DiffPart
) => {
  if (deletion !== undefined && insertion !== undefined) {
    const [oldPrefix, oldSuffix] = [
      leadingWs(deletion.value),
      trailingWs(deletion.value),
    ];
    const [newPrefix, newSuffix] = [
      leadingWs(insertion.value),
      trailingWs(insertion.value),
    ];
    if (startKeep !== undefined) {
      const common = commonPrefix(oldPrefix, newPrefix);
      startKeep.value = swapSuffix(startKeep.value, newPrefix, common);
      deletion.value = withoutPrefix(deletion.value, common);
      insertion.value = withoutPrefix(insertion.value, common);
    }
    if (endKeep !== undefined) {
      const common = commonSuffix(oldSuffix, newSuffix);
      endKeep.value = swapPrefix(endKeep.value, newSuffix, common);
      deletion.value = withoutSuffix(deletion.value, common);
      insertion.value = withoutSuffix(insertion.value, common);
    }
  } else if (insertion !== undefined) {
    if (startKeep !== undefined) {
      insertion.value = insertion.value.slice(
        leadingWs(insertion.value).length
      );
    }
    if (endKeep !== undefined) {
      endKeep.value = endKeep.value.slice(leadingWs(endKeep.value).length);
    }
  } else if (deletion !== undefined) {
    tidyDeletion(startKeep, deletion, endKeep);
  }
};

/** Word by word, each word holding its spaces, as jsdiff's `diffWords`: for prose. */
export const diffWords = (before: string, after: string): DiffPart[] => {
  const parts =
    diffTokens(wordsOf(before), wordsOf(after), {
      equals: (left, right) => left.trim() === right.trim(),
      join: joinWords,
    }) ?? [];
  let lastKeep: DiffPart | undefined;
  let insertion: DiffPart | undefined;
  let deletion: DiffPart | undefined;
  for (const part of parts) {
    if (part.added) {
      insertion = part;
    } else if (part.removed) {
      deletion = part;
    } else {
      if (insertion !== undefined || deletion !== undefined) {
        tidy(lastKeep, deletion, insertion, part);
      }
      lastKeep = part;
      insertion = undefined;
      deletion = undefined;
    }
  }
  if (insertion !== undefined || deletion !== undefined) {
    tidy(lastKeep, deletion, insertion);
  }
  return parts;
};

// ---- The model -----------------------------------------------------------------------------------

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
  const parts = diffLines(before, after, 300) ?? [
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
