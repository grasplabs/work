// How a file's text differs between two versions, line by line, as the
// Code tab's Changes show it (app-code.tsx): the longest common
// subsequence of the two files' lines, after their shared first and last
// lines are set aside, so a small change to a long file costs little.
// A middle too long to compare (`maxCells`) shows as removed and added
// whole rather than freezing the page.

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

/** The most cells of the comparison table worked out for one file. */
const maxCells = 4_000_000;

/** Unchanged lines kept around each change. */
const contextLines = 3;

/** A file's lines; nothing for an empty file, and no last empty line. */
export const linesOf = (text: string): string[] => {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
};

/**
 * The length of the longest common run of `before` from line `row` on
 * and `after` from line `column` on, for each pair, worked out once.
 */
const commonLengths = (
  before: readonly string[],
  after: readonly string[]
): ((row: number, column: number) => number) => {
  const width = after.length + 1;
  const lengths = new Uint32Array((before.length + 1) * width);
  const at = (row: number, column: number): number =>
    lengths[row * width + column] ?? 0;
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      lengths[row * width + column] =
        before[row] === after[column]
          ? at(row + 1, column + 1) + 1
          : Math.max(at(row + 1, column), at(row, column + 1));
    }
  }
  return at;
};

/** The lines of `before` and `after` in the middle that differ, compared. */
const middleDiff = (
  before: readonly string[],
  after: readonly string[],
  start: number
): DiffLine[] => {
  const rows = before.length;
  const columns = after.length;
  if (rows * columns > maxCells) {
    return [
      ...before.map((text, index): DiffLine => ({
        kind: "removed",
        text,
        before: start + index + 1,
      })),
      ...after.map((text, index): DiffLine => ({
        kind: "added",
        text,
        after: start + index + 1,
      })),
    ];
  }
  const common = commonLengths(before, after);
  const lines: DiffLine[] = [];
  let row = 0;
  let column = 0;
  // `start` lines before the middle were shared, in both files alike, so
  // a line's number in either file is its place in the middle after them.
  const numberAt = (index: number): number => start + index + 1;
  while (row < rows || column < columns) {
    const old = before[row];
    const next = after[column];
    if (row < rows && column < columns && old === next) {
      lines.push({
        kind: "same",
        text: old ?? "",
        before: numberAt(row),
        after: numberAt(column),
      });
      row += 1;
      column += 1;
    } else if (
      // On a tie the old line goes first, as diffs print it.
      column < columns &&
      (row === rows || common(row, column + 1) > common(row + 1, column))
    ) {
      lines.push({ kind: "added", text: next ?? "", after: numberAt(column) });
      column += 1;
    } else {
      lines.push({ kind: "removed", text: old ?? "", before: numberAt(row) });
      row += 1;
    }
  }
  return lines;
};

/** Every line of `before` and `after`, each marked how it changed. */
export const diffLines = (before: string, after: string): DiffLine[] => {
  const old = linesOf(before);
  const next = linesOf(after);
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  return [
    ...old.slice(0, head).map((text, index): DiffLine => ({
      kind: "same",
      text,
      before: index + 1,
      after: index + 1,
    })),
    ...middleDiff(
      old.slice(head, old.length - tail),
      next.slice(head, next.length - tail),
      head
    ),
    ...old.slice(old.length - tail).map((text, index): DiffLine => {
      const at = old.length - tail + index;
      return {
        kind: "same",
        text,
        before: at + 1,
        after: next.length - tail + index + 1,
      };
    }),
  ];
};

/**
 * The changed lines of a diff with a few unchanged ones around each, the
 * unchanged stretches between them left out as gaps.
 */
export const withContext = (
  lines: readonly DiffLine[]
): (DiffLine | DiffGap)[] => {
  const near = new Set<number>();
  for (const [index, line] of lines.entries()) {
    if (line.kind !== "same") {
      for (
        let each = Math.max(0, index - contextLines);
        each <= Math.min(lines.length - 1, index + contextLines);
        each += 1
      ) {
        near.add(each);
      }
    }
  }
  const shown: (DiffLine | DiffGap)[] = [];
  let skipped = 0;
  for (const [index, line] of lines.entries()) {
    if (near.has(index)) {
      if (skipped > 0) {
        shown.push({ kind: "gap", lines: skipped });
        skipped = 0;
      }
      shown.push(line);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    shown.push({ kind: "gap", lines: skipped });
  }
  return shown;
};
