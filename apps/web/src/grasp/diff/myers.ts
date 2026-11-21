// The diff's own engine, in place of the npm `diff` package (which the product does not take). The
// three diffs the part uses: lines, words with their spaces (within a changed line), and words
// (prose). It follows jsdiff 9.0.0 step for step (Myers' O(ND) diff, with its choice of path on a
// tie, its tokens and its whitespace tidying for words), so every diff the part drew before is
// drawn the same: scripts/check-diff-engine.ts holds it to jsdiff's own answers on hard cases.
//
// jsdiff is BSD-3-Clause, Copyright (c) 2009-2015, Kevin Decker; this is a rewrite of the parts the
// Diff uses, not a copy of its files.

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
const linesOf = (value: string) => {
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
    linesOf(before).filter((line) => line !== ""),
    linesOf(after).filter((line) => line !== ""),
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
