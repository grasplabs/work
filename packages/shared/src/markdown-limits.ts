/**
 * Whether Markdown text is within what a Markdown renderer takes in about a
 * second, decided by counting characters in one pass, cheap enough to run
 * on every streamed update; text past it shows as plain text. Untrusted
 * text (a model's answer, what someone typed) can otherwise freeze or crash
 * the page that shows it, for whoever opens it, and no parser the kit
 * renders with bounds its own work: marked (Streamdown's block splitter)
 * has no nesting limit and recurses per level, its nested emphasis is
 * quadratic (markedjs/marked#4286), and micromark has open quadratic cases.
 *
 * The counts read no Markdown structure (no fence, block, paragraph or
 * blank line), so no parser can read the text otherwise and slip past
 * them: earlier versions that read structure were wrong four times, each
 * time where a parser saw a line, a blank line or a fence differently.
 *
 * - `characters`: the whole text, as chat products cap a message's length.
 *   Past it, even ordinary Markdown takes more than a second: what it
 *   draws grows with it.
 * - `delimiters`: everything in the text that can delimit inline Markdown:
 *   `*`, `_`, `~`, `` ` `` and every `[` (a link, an image, a reference or
 *   a footnote, closed or not). A `*`, `_` or `~` whose neighbours both
 *   are blanks (`2 * 3`, a list's bullet) can't open or close anything,
 *   nor can a `_` inside a word (`snake_case`): those don't count.
 *   Unclosed delimiters and brackets are rescanned, in quadratic time, and
 *   nested ones overflow the stack.
 * - `footnotes`: each `[^`, again on its own: footnote definitions over
 *   indented lines are quadratic in micromark at a fraction of the
 *   delimiters.
 * - `depth`: the levels a line opens before its text, each block quote
 *   `>` and list marker, and every four columns of indentation. A line is
 *   split at every character any parser may end one at, so every line a
 *   parser reads starts a line here too, and its levels are counted from
 *   there. markdown-it stops at 20 levels in its CommonMark preset
 *   (`maxNesting`). About a thousand levels, two kilobytes, overflow
 *   marked's stack.
 */
export const markdownLimits = {
  characters: 60_000,
  delimiters: 3000,
  footnotes: 500,
  depth: 20,
} as const;

/** Every character a Markdown parser, or JavaScript, may end a line at. */
const lineEnd = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/u;

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

const blank = /\s/u;
const wordCharacter = /[\p{L}\p{N}]/u;

/** Whether `text` is within `markdownLimits`. */
export const withinMarkdownLimits = (text: string): boolean => {
  if (text.length > markdownLimits.characters) {
    return false;
  }
  let delimiters = 0;
  let footnotes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    const before = text[index - 1] ?? " ";
    const after = text[index + 1] ?? " ";
    if (character === "[") {
      delimiters += 1;
      if (after === "^") {
        footnotes += 1;
      }
    } else if (character === "`") {
      delimiters += 1;
    } else if (
      (character === "*" || character === "_" || character === "~") &&
      !(blank.test(before) && blank.test(after)) &&
      !(
        character === "_" &&
        wordCharacter.test(before) &&
        wordCharacter.test(after)
      )
    ) {
      delimiters += 1;
    }
  }
  if (
    delimiters > markdownLimits.delimiters ||
    footnotes > markdownLimits.footnotes
  ) {
    return false;
  }
  return !text.split(lineEnd).some(tooDeep);
};
