/**
 * Whether Markdown text is within what a Markdown renderer takes in about a
 * second, decided in one pass over the text, cheap enough to run on every
 * streamed update; text past it shows as plain text. Untrusted text (a
 * model's answer, what someone typed) can otherwise freeze or crash the
 * page that shows it, for whoever opens it, and no parser the kit renders
 * with bounds its own work: marked (Streamdown's block splitter) has no
 * nesting limit and recurses per level, its nested emphasis is quadratic
 * (markedjs/marked#4286), and micromark has open quadratic cases.
 *
 * - `characters`: the whole text, the first bound, as chat products cap a
 *   message's length. Past it, even ordinary Markdown takes more than a
 *   second: what it draws grows with it.
 * - `depth`: the levels a line opens before its text, each block quote
 *   `>` and list marker, and every four columns of indentation (a list
 *   nests in two, so a page can't nest past twice this). markdown-it
 *   stops at 20 levels in its CommonMark preset (`maxNesting`). About a
 *   thousand levels, two kilobytes of text, overflow marked's stack.
 * - `openers`: what can open emphasis or a link's address in one inline
 *   run, the text a parser reads inline at once: emphasis delimiters that
 *   can open (CommonMark's left-flanking `*` and `~`, and `_` not inside a
 *   word) and `](`. Nested emphasis overflows the stack at about a thousand
 *   levels, and unclosed emphasis or link addresses are rescanned, each
 *   in quadratic time, from one paragraph of a few kilobytes.
 *
 * A run ends at a blank line, a heading or a list item that starts a new
 * block in CommonMark and marked alike, and around a fenced code block
 * opened at a line's start, whose text no parser reads inline; one never
 * closed counts as text. Where a reading is uncertain (a list nested by
 * four columns or more, a block quote, a table row) the run goes on, so
 * the count only ever overstates a run.
 */
export const markdownLimits = {
  characters: 60_000,
  depth: 20,
  openers: 500,
} as const;

/**
 * A level at a line's start, from `lastIndex` on: a block quote's `>`, or
 * a list item's marker, with the blanks after it.
 */
const levelMarker = /(?:>|[*+-](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))[ \t]*/uy;

/** Whether a line opens more levels before its text than `markdownLimits` allows. */
const tooDeep = (line: string): boolean => {
  let columns = 0;
  let index = 0;
  while (line[index] === " " || line[index] === "\t") {
    columns += line[index] === "\t" ? 4 : 1;
    index += 1;
  }
  let depth = Math.floor(columns / 4);
  levelMarker.lastIndex = index;
  while (depth <= markdownLimits.depth && levelMarker.test(line)) {
    depth += 1;
  }
  return depth > markdownLimits.depth;
};

/**
 * A line that starts a new inline run in CommonMark and marked alike: an
 * ATX heading, or a list item with text (a bullet, or `1.`, the only
 * number that may interrupt a paragraph).
 */
const newRun = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[*+-]|1[.)])[ \t]+\S)/u;

/** A fenced code block's opening line at the line's start: its fence. */
const fenceOpening = /^(?<fence>`{3,}(?=[^`]*$)|~{3,})/u;

/**
 * Whether `line` closes a fence of `fence`'s character and length. Marked
 * closes on more lines than CommonMark (fence characters after the
 * fence), and closing early only counts more as text.
 */
const closes = (line: string, fence: string): boolean => {
  const match = /^ {0,3}(?<run>`+|~+)[`~ \t]*$/u.exec(line);
  const run = match?.groups?.run ?? "";
  return run.startsWith(fence.charAt(0)) && run.length >= fence.length;
};

const whitespace = /\s/u;
const punctuation = /[\p{P}\p{S}]/u;
const wordCharacter = /[\p{L}\p{N}]/u;

/**
 * How many emphasis delimiters and link addresses `line` can open: each
 * left-flanking `*` or `~` (CommonMark 6.2, GFM's strikethrough), each
 * such `_` not inside a word, and each `](`.
 */
const openersIn = (line: string): number => {
  let openers = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (character === "]" && line[index + 1] === "(") {
      openers += 1;
    }
    if (character !== "*" && character !== "_" && character !== "~") {
      continue;
    }
    let end = index;
    while (line[end] === character) {
      end += 1;
    }
    const before = line[index - 1] ?? " ";
    const after = line[end] ?? " ";
    const leftFlanking =
      !whitespace.test(after) &&
      (!punctuation.test(after) ||
        whitespace.test(before) ||
        punctuation.test(before));
    if (leftFlanking && (character !== "_" || !wordCharacter.test(before))) {
      openers += end - index;
    }
    index = end - 1;
  }
  return openers;
};

/** Whether `text` is within `markdownLimits`. */
export const withinMarkdownLimits = (text: string): boolean => {
  if (text.length > markdownLimits.characters) {
    return false;
  }
  const lines = text.split("\n");
  // Once a fence is never closed, its text and what follows count as text.
  let fencesClose = true;
  let openers = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = fencesClose
      ? fenceOpening.exec(line)?.groups?.fence
      : undefined;
    if (fence !== undefined) {
      const closing = lines.findIndex(
        (later, at) => at > index && closes(later, fence)
      );
      if (closing === -1) {
        fencesClose = false;
      } else {
        index = closing;
        openers = 0;
        continue;
      }
    }
    if (line.trim() === "" || newRun.test(line)) {
      openers = 0;
    }
    if (tooDeep(line)) {
      return false;
    }
    openers += openersIn(line);
    if (openers > markdownLimits.openers) {
      return false;
    }
  }
  return true;
};
