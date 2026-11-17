// Markdown still being written, made whole. Half-written Markdown flips the layout when its
// closing mark arrives: `**bol` is stars and then bold, a table is a paragraph of pipes and then a
// table. So while an answer streams, what is open at its end is treated as closed (bold, emphasis,
// strike-through, code in a sentence, a link), a table is a table from its first whole row, and a
// last line that is only the start of something (a `#`, a fence, a list mark, half a table row)
// waits for its words. A body row that ends with its last pipe is whole before its line ends. The shape is right from the first character, and nothing re-flows.
//
// Only the end is touched: the result is the source up to `kept`, then what closes it. So a place
// in the source before `kept` is the same place in the result (markdown.tsx fades new words by it).

/** The source made whole: `text` is `source.slice(0, kept)` and then the marks that close it. */
export interface Repaired {
  text: string;
  kept: number;
}

const isFence = (line: string) => /^\s{0,3}(?:`{3,}|~{3,})/u.test(line);

/** Whether `source` ends inside a fence that has not been closed. */
export const openFence = (source: string): boolean =>
  source.split("\n").filter(isFence).length % 2 === 1;

// A last line still being typed that so far is only a mark: a heading's hashes, a list's bullet or
// number, a quote's angle, a rule or a heading's underline, the start of a fence.
const ONLY_A_MARK = /^\s{0,3}(?:#{1,6}|[-=*_+]+|\d{1,9}[.)]?|>+|`+|~+)\s*$/u;
const FENCE_START = /^\s{0,3}(?:`{3,}|~{3,})[^\n]*$/u;
// A table's row: it starts with a pipe. (An answer's tables do; a pipe inside a sentence is not one.)
const ROW = /^\s{0,3}\|/u;
const DELIMITER = /^\s{0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;

/** How many cells a row has. */
const cellsOf = (row: string): number => {
  const inner = row.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return inner.split(/(?<!\\)\|/u).length;
};

/** Where the last line starts, and the line. */
const lastLineOf = (text: string) => {
  const start = text.lastIndexOf("\n") + 1;
  return { start, line: text.slice(start) };
};

/**
 * Whether a last row not yet ended is whole all the same: a body row (the table's head and its row
 * of dashes above it) that ends with a pipe after as many cells as its head has. It is drawn at
 * once, rather than waiting for its line to end through a pause in the stream.
 */
const isWholeRow = (before: string, line: string) => {
  const end = line.trimEnd();
  if (!end.endsWith("|") || end.endsWith("\\|")) {
    return false;
  }
  const lines = before.split("\n").slice(0, -1);
  let first = lines.length;
  while (first > 0 && ROW.test(lines[first - 1] ?? "")) {
    first -= 1;
  }
  const head = lines[first] ?? "";
  return (
    lines.length - first >= 2 &&
    DELIMITER.test(lines[first + 1] ?? "") &&
    cellsOf(end) === cellsOf(head)
  );
};

/**
 * The end of the source with a half-typed last line taken off where it would show as marks: a
 * line that is only a mark, the first line of a fence, a table row not yet ended.
 */
const withoutHalfLine = (source: string): number => {
  const { start, line } = lastLineOf(source);
  if (line === "") {
    return source.length;
  }
  const inFence = openFence(source.slice(0, start));
  if (inFence) {
    // Inside a fence every line is code, but backticks or tildes alone may be the fence closing.
    return /^\s{0,3}(?:`+|~+)\s*$/u.test(line) ? start : source.length;
  }
  if (ROW.test(line) && isWholeRow(source.slice(0, start), line)) {
    return source.length;
  }
  if (ONLY_A_MARK.test(line) || FENCE_START.test(line) || ROW.test(line)) {
    return start;
  }
  return source.length;
};

/**
 * A table whose row of dashes has not arrived (or not all of it): the row of dashes it will have,
 * so its head is a table's head from the moment it is whole. Returns what to keep and what to add.
 */
const tableHead = (text: string): { kept: number; add: string } | null => {
  const lines = text.split("\n");
  // The text ends with whole lines only (withoutHalfLine): the last entry is "".
  const whole = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
  const last = whole.at(-1) ?? "";
  const before = whole.at(-2) ?? "";
  if (!ROW.test(last) || DELIMITER.test(last)) {
    return null;
  }
  // A head: a row with no row above it.
  if (ROW.test(before)) {
    return null;
  }
  const cells = cellsOf(last);
  return {
    kept: text.length,
    add: `${text.endsWith("\n") ? "" : "\n"}|${" --- |".repeat(cells)}\n`,
  };
};

interface Open {
  mark: string;
  at: number;
}

const isWord = (char: string | undefined) =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char);
const isSpace = (char: string | undefined) =>
  char === undefined || /\s/u.test(char);

/** Whether a run of stars, underscores or tildes at `at` is words, not a mark. */
const isLiteral = (block: string, at: number, run: number): boolean => {
  const char = block[at] ?? "";
  const before = block[at - 1];
  const after = block[at + run];
  // An underscore inside a word (snake_case) is a letter, and so is one star (5*3).
  if ((char === "_" || run === 1) && isWord(before) && isWord(after)) {
    return true;
  }
  // A lone tilde is a tilde; a mark with space on both sides is not one.
  if ((char === "~" && run < 2) || (isSpace(before) && isSpace(after))) {
    return true;
  }
  // A star or a line at the start of a line, with a space after it, is a list's bullet.
  const lineStart = block.lastIndexOf("\n", at - 1) + 1;
  return (
    char !== "~" &&
    run === 1 &&
    isSpace(after) &&
    /^[ \t]*$/u.test(block.slice(lineStart, at))
  );
};

/** A run opens its mark, or closes it and whatever was opened inside it. */
const toggle = (open: Open[], mark: string, at: number) => {
  const index = open.findLastIndex((entry) => entry.mark === mark);
  if (index === -1) {
    open.push({ mark, at });
  } else {
    open.splice(index);
  }
};

/** The length of the run of one character at `at`. */
const runAt = (block: string, at: number): number => {
  let run = 1;
  while (block[at + run] === block[at]) {
    run += 1;
  }
  return run;
};

/** The marks left open in a block's words, outermost first, and where code in a sentence is open (or -1). */
const openMarks = (block: string): { open: Open[]; code: number } => {
  const open: Open[] = [];
  let code = -1;
  let at = 0;
  while (at < block.length) {
    const char = block[at] ?? "";
    if (char === "\\") {
      at += 2;
    } else if (char === "`") {
      code = code === -1 ? at : -1;
      at += 1;
    } else if (code !== -1 || !"*_~".includes(char)) {
      at += 1;
    } else {
      const run = runAt(block, at);
      if (!isLiteral(block, at, run)) {
        // A run of three is bold and emphasis; of two, bold (or struck through); of one, emphasis.
        if (run >= 2) {
          toggle(open, char.repeat(2), at);
        }
        if (char !== "~" && run % 2 === 1) {
          toggle(open, char, at);
        }
      }
      at += run;
    }
  }
  return { open, code };
};

/** A link being written at the end of the block: `[words`, `[words](` or `[words](addr`. */
const openLink = (block: string): "words" | "address" | null => {
  const start = block.lastIndexOf("[");
  if (start === -1 || block[start - 1] === "\\" || block[start + 1] === "^") {
    return null;
  }
  const rest = block.slice(start);
  // A task's box is not a link.
  if (
    /^\[[ xX]?\]?$/u.test(rest) &&
    /(?:^|\n)\s*(?:[-*+]|\d+[.)])\s+$/u.test(block.slice(0, start))
  ) {
    return null;
  }
  if (!rest.includes("]")) {
    return rest.includes("\n\n") ? null : "words";
  }
  return /^\[[^\]]*\]\([^)\s]*$/u.test(rest) ? "address" : null;
};

/**
 * `source`, as much as has arrived of an answer, made whole (see the top of this file). Inside an
 * open fence it is all code still coming in, and is left as it is but for a half-typed closing.
 */
export const repair = (source: string): Repaired => {
  const kept = withoutHalfLine(source);
  const text = source.slice(0, kept);
  if (openFence(text)) {
    return { text, kept };
  }
  const head = tableHead(text);
  if (head !== null) {
    return { text: text + head.add, kept };
  }
  // The block being written: what follows the last blank line.
  const blank = text.lastIndexOf("\n\n");
  const from = blank === -1 ? 0 : blank + 2;
  // Marks at the very end (a star that may become two, a mark with no words yet) wait.
  const body = text.slice(from).replace(/[*_~`]+$/u, "");
  const { open, code } = openMarks(body);
  const link = code === -1 ? openLink(body) : null;
  let close = code === -1 ? "" : "`";
  if (link === "words") {
    // No address yet: its words, as words. (`#` leads nowhere, so no link is drawn.)
    close += "](#)";
  } else if (link === "address") {
    close += ")";
  }
  close += open
    .toReversed()
    .map((entry) => entry.mark)
    .join("");
  if (close === "") {
    const end = from + body.length;
    return { text: text.slice(0, end), kept: Math.min(kept, end) };
  }
  // A closing mark closes only right after a word, so the space before it goes.
  const end = from + body.trimEnd().length;
  return { text: text.slice(0, end) + close, kept: Math.min(kept, end) };
};
