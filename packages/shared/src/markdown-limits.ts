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
 * - `delimiters`: emphasis and link delimiters (`*`, `_`, `[`) between two
 *   blank lines, the most one paragraph's inline parse may nest or rescan:
 *   nested emphasis overflows the stack at about a thousand levels, six
 *   kilobytes, far below a length an ordinary answer needs.
 *
 * Counted over code blocks too, whose text no parser reads as Markdown,
 * so no fence the count misreads can hide text from it.
 */
export const markdownLimits = {
  characters: 100_000,
  depth: 20,
  delimiters: 500,
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

/** Whether `text` is within `markdownLimits`. */
export const withinMarkdownLimits = (text: string): boolean => {
  if (text.length > markdownLimits.characters) {
    return false;
  }
  let delimiters = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      delimiters = 0;
      continue;
    }
    if (tooDeep(line)) {
      return false;
    }
    for (const character of line) {
      if (character === "*" || character === "_" || character === "[") {
        delimiters += 1;
      }
    }
    if (delimiters > markdownLimits.delimiters) {
      return false;
    }
  }
  return true;
};
