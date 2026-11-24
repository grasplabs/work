// Markdown's pure half (markdown.tsx draws what this reads, repair.ts makes whole what is still
// being written): the parse to a syntax tree, with GitHub's additions (tables, task lists,
// strikethrough, autolinks, footnotes); which links may lead anywhere; the blocks of a long answer
// read a block at a time; and the one HTML form drawn as a section that folds. Never HTML: raw
// HTML in the source stays a text node, drawn as text. No React here, so all of it is tested as
// plain functions (scripts/markdown-parse.test.ts).
//
// Pinned as the product resolves them: mdast-util-from-markdown 2.0.3, micromark-extension-gfm
// 3.0.0, mdast-util-gfm 3.1.0.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

// ---- The tree -----------------------------------------------------------------------------------

/** A Markdown syntax tree (mdast). */
export type MarkdownRoot = ReturnType<typeof fromMarkdown>;

// The parser's work grows faster than what it reads in two ways, and each is bounded here.
//
// Inside a paragraph (or heading, or table cell) it weighs every mark against the marks before it
// and moves the rest of the paragraph for each (micromark's resolveAllText): `m` marks take up to
// 80 ns times `m` squared, half a second for the 2,700 that 8,000 characters can hold, a
// millisecond for the 128 of a paragraph dense with links, bold and code. So a paragraph of at
// most FREE_MARKS marks is always read for them. One with more spends its marks squared from
// MAX_COST, a tenth of a second's reading, so a paragraph of more than about 1,200 marks never is;
// and once that is spent such paragraphs are their own characters, as plain text, in
// their place (in their list item, quote or cell). So is one longer than MAX_INLINE. To find them,
// the source is read first for its blocks alone, with nothing inline; then with each plain block's
// characters stood in for by one that starts no mark, and they are given back.
//
// Across blocks: every item of a list moves every later event of the whole answer (mdast's
// prepareList, 19 s for a list of 400 KB), and every line given to a quote or an item without its
// mark looks through the lines before it (micromark's document): up to 60 ns times the lines
// squared, and each more for every quote and item it opens. So an answer is read in pieces, each by
// itself, and their blocks stand one after the other. A line weighs one, or as many quotes and
// list items as it opens. A piece ends, once it weighs PIECE, where the parser starts anew
// whatever came before: at a line at the margin after a blank line, that is no list item (which
// would go on in a list before it). One block has no such place, and is bounded as readWith says.

/** The longest paragraph, heading or table cell read for its marks. */
const MAX_INLINE = 8000;
/** The most marks a paragraph, heading or table cell holds and is read for them whatever came before. */
const FREE_MARKS = 128;
/** What the paragraphs with more marks may cost in one read, each its marks squared. */
const MAX_COST = 1_500_000;
/** What a piece's lines weigh before it ends where the next block starts. */
const PIECE = 64;
/** What the pieces may cost in one read, each its weight squared: a tenth of a second at the costliest. */
const MAX_LINES = 2_000_000;

/** Every construct the parser reads inside a paragraph, by name: off while the blocks are found. */
const INLINE =
  "attention autolink characterEscape characterReference codeText emailAutolink gfmFootnoteCall gfmPotentialFootnoteCall hardBreakEscape htmlText labelEnd labelStartImage labelStartLink protocolAutolink strikethrough tasklistCheck wwwAutolink".split(
    " "
  );

// Strike-through is two tildes, as a model writes it: one is a tilde (`20~25°C`, `~5 minutes`).
const GFM = gfm({ singleTilde: false });
const FROM_GFM = gfmFromMarkdown();
// With nothing inline, bare web addresses are left as words too: they are found in the words after
// the parse (mdast-util-gfm's transform), which would take the words' places away.
const NO_INLINE = { disable: { null: INLINE } };
const NO_TRANSFORMS = FROM_GFM.map((extension) => ({
  ...extension,
  transforms: [],
}));

const parsed = (source: string, inline = true): MarkdownRoot =>
  inline
    ? fromMarkdown(source, { extensions: [GFM], mdastExtensions: [FROM_GFM] })
    : fromMarkdown(source, {
        extensions: [GFM, NO_INLINE],
        mdastExtensions: NO_TRANSFORMS,
      });

/** A place in the source. */
interface Point {
  line: number;
  column: number;
  offset?: number;
}

/** A node of the tree, as far as the bounds read it. */
interface Node {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: Point; end: Point };
  identifier?: string;
}

const each = (node: Node, visit: (node: Node) => void) => {
  visit(node);
  for (const child of node.children ?? []) {
    each(child, visit);
  }
};

const startOf = (node: Node) => node.position?.start.offset ?? 0;
const endOf = (node: Node) => node.position?.end.offset ?? 0;

const isBlank = (char: string | undefined) =>
  char === undefined || char === " " || char === "\t";

/**
 * Where the characters of `text`, a text node read with nothing inline, are in `source`: each of its
 * lines is the end of its line there, before the line's trailing spaces (the marks of the quotes and
 * lists round it come before). Null if a line is not found so.
 */
const placesOf = (source: string, text: Node): [number, number][] | null => {
  let at = startOf(text);
  const end = text.position?.end.offset ?? at;
  const places: [number, number][] = [];
  for (const line of (text.value ?? "").split(/\r\n|\r|\n/u)) {
    let stop = at;
    while (stop < end && source[stop] !== "\n" && source[stop] !== "\r") {
      stop += 1;
    }
    let last = stop;
    while (last > at && isBlank(source[last - 1])) {
      last -= 1;
    }
    const from = last - line.length;
    if (from < at || source.slice(from, last) !== line) {
      return null;
    }
    places.push([from, last]);
    at = stop + (source.startsWith("\r\n", stop) ? 2 : 1);
  }
  return places;
};

/** The characters a mark starts or ends with, by their code. */
const MARKS = new Set(Array.from("[]*_<&\\!~`", (char) => char.codePointAt(0)));
/** What a comment, an instruction or a declaration left open counts for: it is read on to its paragraph's end. */
const READ_ON = 16;

/**
 * How many marks `text` holds: each character of MARKS, each space inside a bracket left open (every
 * word there looks back for the bracket), and READ_ON more for each `<!` and `<?`.
 */
const marksOf = (text: string): number => {
  let marks = 0;
  let open = 0;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.codePointAt(at) ?? 0;
    if (MARKS.has(code)) {
      const next = text[at + 1];
      open += Number(code === 91) - Number(code === 93 && open > 0);
      marks += code === 60 && (next === "!" || next === "?") ? READ_ON + 1 : 1;
    } else if (open > 0 && code <= 32) {
      marks += 1;
    }
  }
  return marks;
};

/** A blank line. */
const BLANK_LINE = /\n[ \t\r]*\n/u;

/**
 * Whether some lines with no blank line between them, as a block's are, run over MAX_INLINE or
 * hold more than FREE_MARKS marks: only then are the blocks found first.
 */
const mayCost = (source: string): boolean =>
  source
    .split(BLANK_LINE)
    .some((run) => run.length > MAX_INLINE || marksOf(run) > FREE_MARKS);

/**
 * What one read may still spend on paragraphs with more than FREE_MARKS marks, and where each that
 * spent stands and what it spent; where in the answer the first paragraph stands that it had too
 * little for, from where on there is nothing; how far what is being read stands from the answer's
 * start; and how many names defined elsewhere a piece is read with (see blocksOf).
 */
interface Budget {
  left: number;
  charged: [number, number][];
  spent: number;
  shift: number;
  names: number;
}

/**
 * Where the characters of each paragraph, heading or table cell are that is not read for its marks
 * (over MAX_INLINE, or costing more than the budget has left), or null.
 */
const longInline = (source: string, budget: Budget): Uint8Array | null => {
  if (!mayCost(source)) {
    return null;
  }
  const long = new Uint8Array(source.length);
  let any = false;
  each(parsed(source, false), (node) => {
    const texts = (node.children ?? []).filter(({ type }) => type === "text");
    if (texts.length === 0) {
      return;
    }
    let length = 0;
    let marks = 0;
    for (const { value = "" } of texts) {
      length += value.length;
      marks += marksOf(value);
    }
    if (length <= MAX_INLINE) {
      const at = startOf(node) + budget.shift;
      const cost = marks > FREE_MARKS ? marks * marks : 0;
      if (cost <= (at < budget.spent ? budget.left : 0)) {
        budget.left -= cost;
        if (cost > 0) {
          budget.charged.push([at, cost]);
        }
        return;
      }
      // Nothing after it is read for more than FREE_MARKS either: plain text does not turn back.
      budget.spent = Math.min(budget.spent, at);
    }
    const places = texts.map((text) => placesOf(source, text));
    if (places.every((place) => place !== null)) {
      any = true;
      for (const [from, to] of places.flat()) {
        long.fill(1, from, to);
      }
    }
  });
  return any ? long : null;
};

/** What stands in for each character of a long block: no mark starts with it. */
const STAND_IN = "§";

/** `tree`, read from `source` with its long characters stood in for, with them given back. */
const givenBack = (tree: MarkdownRoot, source: string, long: Uint8Array) => {
  each(tree, (node) => {
    const from = node.position?.start.offset ?? -1;
    const to = node.position?.end.offset ?? -1;
    if (node.type !== "text" || long[from] !== 1) {
      return;
    }
    const originals: string[] = [];
    for (let at = from; at < to; at += 1) {
      if (long[at] === 1) {
        originals.push(source[at] ?? "");
      }
    }
    let index = 0;
    node.value = (node.value ?? "").replaceAll(STAND_IN, () => {
      index += 1;
      return originals[index - 1] ?? "";
    });
  });
  return tree;
};

/** The tree of `source` read in one piece, its long and its costly blocks plain text. */
const treeOf = (source: string, budget: Budget): MarkdownRoot => {
  const long = longInline(source, budget);
  if (long === null) {
    return parsed(source);
  }
  const stood = Array.from(long, (on, at) =>
    on === 1 ? STAND_IN : (source[at] ?? "")
  ).join("");
  return givenBack(parsed(stood), source, long);
};

const isSpaceOrTab = (char: string | undefined) =>
  char === " " || char === "\t";
const isDigit = (char: string | undefined) =>
  char !== undefined && char >= "0" && char <= "9";

/** Past the spaces and tabs in `line` from `at`. */
const blankFrom = (line: string, at: number): number => {
  let end = at;
  while (isSpaceOrTab(line[end])) {
    end += 1;
  }
  return end;
};

/**
 * Where a list item's mark at `at` ends (`-`, `*`, `+`, or a number of at most nine digits and
 * `.` or `)`) before a space, a tab or the line's end; -1 for none.
 */
const itemMarkEnd = (line: string, at: number): number => {
  let end = at;
  while (end <= at + 9 && isDigit(line[end])) {
    end += 1;
  }
  const bullet = line[at] === "-" || line[at] === "*" || line[at] === "+";
  const number =
    end > at && end <= at + 9 && (line[end] === "." || line[end] === ")");
  if (!bullet && !number) {
    return -1;
  }
  end += 1;
  return end === line.length || isSpaceOrTab(line[end]) ? end : -1;
};

/**
 * The marks of the quotes and list items that open a line: where they end, with the spaces round
 * them, and how many there are.
 */
const containersOf = (line: string) => {
  for (let at = 0, count = 0; ; count += 1) {
    const mark = blankFrom(line, at);
    const end = line[mark] === ">" ? mark + 1 : itemMarkEnd(line, mark);
    if (end === -1) {
      return { end: mark, count };
    }
    at = end;
  }
};
export const containersEnd = (line: string) => containersOf(line).end;

/**
 * What a line weighs in a piece: one, or as many quotes and list items as it opens, as each is
 * more for the parser to carry from line to line.
 */
const weightOf = (line: string) => Math.max(1, containersOf(line).count);

/** Where a line's quote marks end (each with one space after it at most), and how many there are. */
const quotesOf = (line: string) => {
  let depth = 0;
  for (let at = 0; ; depth += 1) {
    const mark = blankFrom(line, at);
    if (line[mark] !== ">") {
      return { end: at, depth };
    }
    at = mark + (isSpaceOrTab(line[mark + 1]) ? 2 : 1);
  }
};

const FENCE = /^(?:`{3,}|~{3,})/u;

/** The fence's run `rest` starts with, a line once its containers are passed, or "": a backtick fence's words hold no backtick. */
export const fenceRun = (rest: string): string => {
  const run = FENCE.exec(rest)?.[0] ?? "";
  return run.startsWith("`") && rest.includes("`", run.length) ? "" : run;
};

/** Where the fences stand after a line: the run of the one still open ("" for none), its depth in quotes and how far in it is. */
interface Fences {
  open: string;
  depth: number;
  indent: number;
}

/**
 * Whether `line` is code (a fence's own line, or one inside a fence), however deep in quotes and
 * lists the fence stands, given where the fences stood before it, which it moves on. A fence in a
 * quote or a list item ends with it: at a line with fewer quote marks, or with words less far in.
 */
const isCode = (fences: Fences, line: string): boolean => {
  const quotes = quotesOf(line);
  const inner = line.slice(quotes.end);
  const words = containersEnd(line);
  const rest = line.slice(words);
  const run = fenceRun(rest);
  if (
    fences.open !== "" &&
    quotes.depth >= fences.depth &&
    (inner.trim() === "" ||
      inner.length - inner.trimStart().length >= fences.indent)
  ) {
    if (
      run.startsWith(fences.open.charAt(0)) &&
      run.length >= fences.open.length &&
      rest.slice(run.length).trim() === ""
    ) {
      fences.open = "";
    }
    return true;
  }
  fences.open = run;
  fences.depth = quotes.depth;
  fences.indent = words - quotes.end;
  return run !== "";
};

/** Which lines are code, and the run of the fence still open at the end ("" for none). */
export const codeLines = (lines: readonly string[]) => {
  if (!lines.some((line) => line.includes("``") || line.includes("~~"))) {
    return { code: [], open: "" };
  }
  const fences = { open: "", depth: 0, indent: 0 };
  const code = lines.map((line) => isCode(fences, line));
  return { code, open: fences.open };
};

/** Where a piece starts: its place, its line (from 0), and whether it is plain lines. */
interface Start {
  from: number;
  line: number;
  plain: boolean;
}

/** A line's end. */
const EOL = /\r\n?|\n/gu;
/** A line at the margin that starts no list item, which would go on in a list before it. */
const MARGIN = /^(?!(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))[^ \t]/u;
/** A line as far in as indented code: the parser reads the line after such code as one after a paragraph. */
const DEEP = /^(?: {4}| {0,3}\t)/u;

/** Where the line at `at` ends, and where the next starts. */
const lineAt = (source: string, at: number) => {
  EOL.lastIndex = at;
  const end = EOL.exec(source)?.index ?? source.length;
  return { end, next: end === source.length ? end : EOL.lastIndex };
};

/**
 * Where the piece that starts at `start` ends: where a block starts once it weighs PIECE lines (see
 * above), and at any line (`cut`) once it weighs `max`; each line weighs one, or as many quotes
 * and list items as it opens (weightOf).
 */
const pieceAt = (source: string, start: Start, max: number) => {
  let blank = false;
  let deep = false;
  let at = start.from;
  for (let lines = 0, weight = 0; at < source.length; lines += 1) {
    const { end, next } = lineAt(source, at);
    const text = source.slice(at, end);
    const starts = blank && !deep && MARGIN.test(text);
    if (
      starts ? start.plain || weight >= PIECE : weight >= max && !start.plain
    ) {
      return { to: at, cut: !starts, lines };
    }
    blank = /^[ \t]*$/u.test(text);
    deep = blank ? deep : DEEP.test(text);
    weight += weightOf(text);
    at = next;
  }
  return { to: source.length, cut: false, lines: 0 };
};

/** The paragraphs of plain lines: readBlocks keeps nothing while an answer has them. */
const PLAIN = new WeakSet<object>();

/** `text` as plain lines: a paragraph for each run of them, every line on its own. */
const plainBlocks = (text: string): Node[] => {
  const blocks: Node[] = [];
  let open: Node[] | undefined;
  for (const line of text.split(EOL)) {
    if (line.trim() === "") {
      open = undefined;
    } else if (open === undefined) {
      open = [{ type: "text", value: line.trimEnd() }];
      const paragraph = { type: "paragraph", children: open };
      PLAIN.add(paragraph);
      blocks.push(paragraph);
    } else {
      open.push({ type: "break" }, { type: "text", value: line.trimEnd() });
    }
  }
  return blocks;
};

/** Whether a name is as the parser compares names: no capital, no space but one between words. */
const isCompared = (name: string) => {
  let before = 32;
  for (let at = 0; at < name.length; at += 1) {
    const code = name.codePointAt(at) ?? 0;
    const plain = (code > 32 && code < 65) || (code > 90 && code < 127);
    if (!plain && (code !== 32 || before === 32)) {
      return false;
    }
    before = code;
  }
  return before !== 32;
};

/** A name as the parser compares names: its spaces one each, in one case. Most are so as written. */
const nameOf = (name: string) =>
  isCompared(name)
    ? name
    : name
        .replaceAll(/[\t\n\r ]+/gu, " ")
        .trim()
        .toLowerCase()
        .toUpperCase()
        .toLowerCase();

const isEnd = (char: string | undefined) =>
  char === undefined || char === "\n" || char === "\r";

/**
 * The name a definition of a link's target or a note starts with at `at` in `text` (at most three
 * spaces, the name in brackets, a colon: `[name]: …`, `[^1]: …`), as it is written, or null. On
 * its line, unless `lines`: a name may run on over lines.
 */
const definedAt = (text: string, at: number, lines = false): string | null => {
  let start = at;
  while (start < at + 3 && text[start] === " ") {
    start += 1;
  }
  if (text[start] !== "[") {
    return null;
  }
  let end = start + 1;
  while (end < text.length && text[end] !== "]") {
    if (text[end] === "\\") {
      // An escape is of a character on the line.
      end += isEnd(text[end + 1]) ? text.length : 2;
    } else if (!lines && isEnd(text[end])) {
      return null;
    } else {
      end += 1;
    }
  }
  return end > start + 1 && end < text.length && text[end + 1] === ":"
    ? text.slice(start + 1, end)
    : null;
};

/** Each definition's name in `source` (see definedAt), as written, and where its line starts. */
const definitionsIn = (source: string): [string, number][] => {
  const found: [string, number][] = [];
  for (let at = 0; at < source.length;) {
    const label = definedAt(source, at);
    if (label !== null) {
      found.push([label, at]);
    }
    const end = source.indexOf("\n", at);
    at = end === -1 ? source.length : end + 1;
  }
  return found;
};

/** What an answer defines: each name as the parser compares it, as it is written, and where it is defined. */
type Defined = Map<string, { written: string; at: number }>;

/** `defined` with the name `label`, defined at `at`, unless it is defined: the first to define a name does. */
const define = (defined: Defined, label: string, at: number) => {
  const name = nameOf(label);
  return defined.has(name)
    ? defined
    : defined.set(name, { written: label, at });
};

/** The names in brackets in `text`, as a link or a note may be referred to: from each `[` to the next bracket. */
const namesIn = (text: string): string[] => {
  const names: string[] = [];
  let open = -1;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") {
      at += 1;
    } else if (char === "[") {
      open = at;
    } else if (char === "]" && open !== -1) {
      if (at > open + 1) {
        names.push(text.slice(open + 1, at));
      }
      open = -1;
    }
  }
  return names;
};

/** `text` without the blank lines at its end, after the end of its last line with words. */
const withoutBlankEnd = (text: string): string => {
  let last = text.length;
  while (last > 0 && " \t\r\n".includes(text[last - 1] ?? "")) {
    last -= 1;
  }
  let eol = last;
  while (text[eol] === " " || text[eol] === "\t") {
    eol += 1;
  }
  const after = eol + (text.startsWith("\r\n", eol) ? 2 : 1);
  // Only blank lines, each ended: what an ended line leaves after it.
  return after < text.length && isEnd(text.at(-1))
    ? text.slice(0, after)
    : text;
};

/**
 * The blocks of the piece from `start` to `to`, and whether it ends in code or HTML that nothing
 * closed, so that it runs to the piece's very end. A line that defines each name the piece refers to
 * and another piece defines is read before it, with nothing but the name (what the name leads to is
 * read where it is defined), so a link or a note defined there is one here too; what was read from
 * those lines is dropped, and every place is the source's.
 */
const blocksOf = (
  source: string,
  { from, line, plain }: Start,
  to: number,
  defined: Defined,
  budget: Budget
): { blocks: Node[]; open: boolean } => {
  if (plain) {
    return { blocks: plainBlocks(source.slice(from, to)), open: false };
  }
  // Without the blank lines at its end, which would be the code's own.
  const text =
    to < source.length
      ? withoutBlankEnd(source.slice(from, to))
      : source.slice(from);
  // The parser looks each reference up in a list of every name defined, so a piece that refers to
  // thousands of names defined elsewhere would cost their product: one read while an answer is
  // written gives it budget.names of them, and past that a name is its words until the answer is
  // whole and read whole.
  const names = new Set<string>();
  for (const name of defined.size === 0 ? [] : namesIn(text)) {
    const found = defined.get(nameOf(name));
    if (names.size === budget.names) {
      break;
    }
    if (found !== undefined && (found.at < from || found.at >= to)) {
      names.add(`[${found.written}]: <>\n`);
    }
  }
  // A comment ends them, so no line of the piece is taken for more of the last. It stands before
  // a byte order mark too, which the parser passes over at the start of what it reads.
  const bare = names.size === 0 && !text.startsWith("\uFEFF");
  // Notes last: the line after a note would be the note's own.
  const sorted = [...names].toSorted(
    (one, other) => Number(one[1] === "^") - Number(other[1] === "^")
  );
  const stubs = bare ? "" : `${sorted.join("")}\n<!---->\n\n`;
  budget.shift = from - stubs.length;
  const tree: Node = treeOf(stubs + text, budget);
  const blocks = (tree.children ?? []).filter(
    (node) => startOf(node) >= stubs.length
  );
  const last = blocks.at(-1);
  const open =
    to < source.length &&
    (last?.type === "code" || last?.type === "html") &&
    endOf(last) === stubs.length + text.length;
  const lines = line - stubs.split("\n").length + 1;
  const moved = (point: Point) => {
    point.offset = (point.offset ?? 0) + budget.shift;
    point.line += lines;
  };
  for (const block of blocks) {
    each(block, ({ position }) => {
      if (position !== undefined) {
        moved(position.start);
        moved(position.end);
      }
    });
  }
  return { blocks, open };
};

/** The lines `node` stands on. */
const linesOf = ({ position }: Node) =>
  position === undefined ? 0 : position.end.line - position.start.line + 1;

/** The blocks that cost the parser no more than their length, however many lines they are. */
const IN_STEP = new Set(["code", "definition", "html"]);

/** How HTML that a blank line does not end starts, and what the line holds that ends it. */
const RAW_HTML: [RegExp, RegExp][] = [
  [
    /^<(?:script|pre|style|textarea)(?:[ \t>]|$)/iu,
    /<\/(?:script|pre|style|textarea)>/iu,
  ],
  [/^<!--/u, /-->/u],
  [/^<\?/u, /\?>/u],
  [/^<![a-z]/iu, />/u],
  [/^<!\[CDATA\[/u, /\]\]>/u],
];

/** Whether `line` closes a fence opened with `run`: at most three spaces in, as long a run of its mark or longer, nothing after. */
const closesFence = (line: string, run: string) => {
  let at = 0;
  while (at < 3 && line[at] === " ") {
    at += 1;
  }
  let length = 0;
  while (line[at + length] === run[0]) {
    length += 1;
  }
  return length >= run.length && /^[ \t]*$/u.test(line.slice(at + length));
};

/**
 * Where the code or HTML ends that starts at `from` and that the parser, reading as far as `to`,
 * found nothing to close: after the first line from `to` on that closes the fence it opens with,
 * or ends such HTML.
 */
const closedAt = (source: string, from: number, to: number): number => {
  const first = source.slice(from, from + 1024).trimStart();
  const run = FENCE.exec(first)?.[0] ?? "";
  const html = RAW_HTML.find(([opening]) => opening.test(first))?.[1];
  const ends = (line: string) =>
    run === "" ? html?.test(line) === true : closesFence(line, run);
  let at = run === "" && html === undefined ? source.length : to;
  while (at < source.length) {
    const { end, next } = lineAt(source, at);
    if (ends(source.slice(at, end))) {
      return next;
    }
    at = next;
  }
  return source.length;
};

/**
 * The blocks of `source`, read piece by piece, with the names `defined` holds. A piece that weighs
 * more than PIECE, the lines of IN_STEP blocks apart, spends its weight squared from MAX_LINES, and
 * weighs no more than what is left allows. One that ended for its length ended inside a block, unless
 * that defined a link: the lines after it are plain lines, up to where the next block starts. And
 * the parser says whether a piece ended where it may: one whose last block is code or HTML that
 * runs to its very end ended inside that block, which is then read by itself, to its own end.
 */
const readWith = (source: string, defined: Defined, budget: Budget) => {
  const blocks: Node[] = [];
  let left = MAX_LINES;
  let start = { from: 0, line: 0, plain: false };
  let closed: number | undefined;
  while (start.from < source.length) {
    const max = Math.max(PIECE, Math.floor(Math.sqrt(left)));
    const piece =
      closed === undefined
        ? pieceAt(source, start, max)
        : { to: closed, cut: false, lines: 0 };
    const { to, cut } = piece;
    const read = blocksOf(source, start, to, defined, budget);
    const open = read.open && closed === undefined;
    const last = read.blocks.at(-1);
    const whole = open ? read.blocks.slice(0, -1) : read.blocks;
    const at = last?.position?.start ?? { line: 1, column: 1, offset: 0 };
    const from = open ? (at.offset ?? 0) - at.column + 1 : to;
    const lines =
      open || piece.lines === 0
        ? source.slice(start.from, from).split(EOL).length - 1
        : piece.lines;
    let weight = 0;
    for (const line of source.slice(start.from, from).split(EOL)) {
      weight += weightOf(line);
    }
    const counted = whole.reduce(
      (sum, node) => sum - (IN_STEP.has(node.type) ? linesOf(node) : 0),
      weight - 1
    );
    left = Math.max(0, left - (counted > PIECE ? counted ** 2 : 0));
    for (const block of whole) {
      blocks.push(block);
    }
    closed = open ? closedAt(source, from, to) : undefined;
    start = {
      from,
      line: start.line + lines,
      plain: cut && last?.type !== "definition",
    };
  }
  return blocks;
};

/**
 * The tree of `source`, given `budget`, with the names `outer` holds defined elsewhere. An answer of
 * few lines that refers to none is read whole. Otherwise the lines that look to define a name are
 * taken to; should the pieces, once read, define other names (a line of a paragraph only looks to, a
 * line in a quote does), they are read again with those.
 */
const rootOf = (
  source: string,
  budget: Budget,
  outer: Defined
): MarkdownRoot => {
  const start = { from: 0, line: 0, plain: false };
  if (outer.size === 0 && pieceAt(source, start, PIECE).to === source.length) {
    return treeOf(source, budget);
  }
  const guessed: Defined = new Map(outer);
  for (const [label, at] of definitionsIn(source)) {
    define(guessed, label, source.indexOf("[", at));
  }
  const before = { ...budget, charged: [...budget.charged] };
  let blocks = readWith(source, guessed, budget);
  const defined: Defined = new Map(outer);
  for (const block of blocks) {
    each(block, (node) => {
      if (node.type === "definition" || node.type === "footnoteDefinition") {
        const at = startOf(node);
        define(defined, definedAt(source, at, true) ?? "", at);
      }
    });
  }
  const same =
    defined.size === guessed.size &&
    [...defined].every(([name, { at }]) => guessed.get(name)?.at === at);
  if (!same) {
    blocks = readWith(source, defined, Object.assign(budget, before));
  }
  const lines = source.split(EOL);
  const end = {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
    offset: source.length,
  };
  const position = { start: { line: 1, column: 1, offset: 0 }, end };
  const root: MarkdownRoot = { type: "root", children: [], position };
  const into: Node[] = root.children;
  for (const block of blocks) {
    into.push(block);
  }
  return root;
};

/**
 * `source` as the parser reads it, which passes over a byte order mark at its start, with the names
 * `outer` holds defined (where, the answer around it says).
 */
const guarded = (
  source: string,
  budget: Budget,
  outer: Defined = new Map()
): MarkdownRoot => {
  try {
    return rootOf(source.replace(/^\uFEFF/u, ""), budget, outer);
  } catch {
    return {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: source }] },
      ],
    };
  }
};

/**
 * The tree of `source`. Each node keeps its offsets in the source. A paragraph, heading or table
 * cell longer than MAX_INLINE, or with more marks than FREE_MARKS once MAX_COST is spent, is its own
 * characters, as plain text, and so are the lines past MAX_LINES. Should the parser fail all the
 * same, the source is one paragraph of its own words: an answer is always drawn.
 */
export const parseMarkdown = (source: string): MarkdownRoot =>
  guarded(source, {
    left: MAX_COST,
    charged: [],
    spent: Number.POSITIVE_INFINITY,
    shift: 0,
    names: Number.POSITIVE_INFINITY,
  });

// The tree's node types, read from the parser's own return type, so nothing beyond the parser is
// needed. Markdown's own: they never leave the folder.
export type RootContent = MarkdownRoot["children"][number];
type Of<Type extends RootContent["type"]> = Extract<
  RootContent,
  { type: Type }
>;
export type FootnoteDefinition = Of<"footnoteDefinition">;
export type List = Of<"list">;
export type ListItem = List["children"][number];
export type TableNode = Of<"table">;
export type Paragraph = Of<"paragraph">;
export type PhrasingContent = Paragraph["children"][number];
type TableRow = TableNode["children"][number];
/** A node of the syntax tree Markdown draws: a block, a phrase, a list's item, a table's row or cell. */
export type MarkdownNode =
  | RootContent
  | PhrasingContent
  | ListItem
  | TableRow
  | TableRow["children"][number];

// ---- Links --------------------------------------------------------------------------------------

/**
 * A link's scheme as a browser reads it, in lower case, for a host's allow-list: what leads the
 * address once the spaces and control characters round it, and any tab or line break in it, are
 * dropped (so `JaVa\tScript:` is `javascript`). Empty for an address with no scheme (a relative
 * path, `#…`).
 */
export const schemeOf = (url: string): string => {
  // A browser drops the spaces and control characters (code 32 and under) round an address.
  let start = 0;
  let end = url.length;
  while (start < end && (url.codePointAt(start) ?? 0) <= 32) {
    start += 1;
  }
  while (end > start && (url.codePointAt(end - 1) ?? 0) <= 32) {
    end -= 1;
  }
  const cleaned = url.slice(start, end).replaceAll(/[\t\n\r]/gu, "");
  const scheme = /^(?<scheme>[a-z][a-z\d+.-]*):/iu.exec(cleaned)?.groups
    ?.scheme;
  return scheme === undefined ? "" : scheme.toLowerCase();
};

/**
 * An address as CommonMark writes it into a link: each character an address does not take as it
 * is, percent-encoded (`\` is `%5C`, where a browser would read it as a `/`), a `%` that starts an
 * escape kept.
 */
export const encodedUrl = (url: string): string =>
  url.replaceAll(
    /%(?![\dA-Fa-f]{2})|[^!#$%&'()*+,\-./\d:;=?@A-Z_a-z~]/gu,
    (char) => {
      try {
        return encodeURIComponent(char);
      } catch {
        // Half of a character that takes two units: no character, so the replacement character.
        return "%EF%BF%BD";
      }
    }
  );

// ---- Bounds: what no answer needs, taken out before the parse ------------------------------------
//
// The parser recurses into every quote and list it opens, so a hostile answer, or a model's runaway,
// could exhaust the stack with a few thousand `- ` or `>` on a line. None of that is in a real
// answer, so a quote or a list deeper than MAX_DEPTH on a line is words from there: a backslash
// undoes the first mark past it, and it shows as the character it is. Code in a fence is left as it
// is. (A long paragraph's cost is bounded in the parse: see MAX_INLINE.) And a NUL is the
// replacement character, as the parser reads it, so each character of the source is one it reads.

/** The deepest quote or list a line opens. */
const MAX_DEPTH = 32;

const FOOTNOTE_START = /^\[\^[^\]\s]+\]:/u;
const ORDERED = /^\d{1,9}[.)](?:[ \t]|$)/u;
/**
 * Where a backslash undoes the first container mark past MAX_DEPTH that opens `line` (quotes, list
 * items, footnotes), or -1. Indentation counts as a level for every two columns, as a nested list
 * needs at least that.
 */
const depthOver = (line: string): number => {
  let at = 0;
  let depth = 0;
  let columns = 0;
  for (;;) {
    while (line[at] === " " || line[at] === "\t") {
      columns += line[at] === "\t" ? 4 : 1;
      at += 1;
    }
    const rest = line.slice(at, at + 1024);
    const ordered = ORDERED.exec(rest)?.[0].trimEnd();
    let width = 0;
    // Where a backslash undoes the mark: before it, or before an ordered item's dot.
    let undo = at;
    if (
      line[at] === ">" ||
      ("-*+".includes(line[at] ?? "x") && isBlank(line[at + 1]))
    ) {
      width = 1;
    } else if (ordered === undefined) {
      width = FOOTNOTE_START.exec(rest)?.[0].length ?? 0;
    } else {
      width = ordered.length;
      undo = at + width - 1;
    }
    if (width === 0) {
      return -1;
    }
    if (depth + Math.floor(columns / 2) >= MAX_DEPTH) {
      return undo;
    }
    depth += 1;
    at += width;
  }
};

/** `source` within the bounds above: the same answer, its quotes and lists past MAX_DEPTH words. */
export const bounded = (source: string): string => {
  const lines = source.replaceAll("\0", "\uFFFD").split("\n");
  const { code } = codeLines(lines);
  return lines
    .map((line, index) => {
      if (code[index] === true) {
        return line;
      }
      const over = depthOver(line);
      return over === -1 ? line : `${line.slice(0, over)}\\${line.slice(over)}`;
    })
    .join("\n");
};

// ---- Blocks: a long answer read a block at a time ---------------------------------------------------
//
// Reading the whole answer again for every few words that arrive costs more the longer it gets. But
// only its last block can still change: the blocks before it are finished. So they are kept as they
// were read, with the source they were read from, the names they define and what they spent of the
// budget of marks, and only what follows them is read again, with those names and what is left. A
// note whose definition has not arrived yet (`[^1]`) is read as one, as it will be: a model writes
// its notes at the end. A reference to a link whose definition has not arrived (`[the wiki][wiki]`)
// is its words as written until then, which `m[0][1]` or a citation `[1][2]` that nothing defines
// stays.

/** A block of the answer, and where it starts in the source: its nodes' places count from there. */
export interface Placed {
  node: RootContent;
  base: number;
}

/**
 * The blocks that are finished, and the source they were read from; what they left of the budget
 * of marks; and where in the answer the first paragraph stands that was plain text for want of
 * budget, if one was: it stays plain.
 */
export interface Kept {
  text: string;
  blocks: Placed[];
  left?: number;
  spent?: number;
  /** The names the kept blocks define. */
  defined?: Defined;
}

export const NOTHING: Kept = { text: "", blocks: [] };

/** The longest name of a note, as the parser reads one: at most 999 characters after its `[`. */
const MAX_NOTE = 999;

/**
 * `defined`, with each note that `text` refers to (`[^name]`, no space or bracket in the name) and
 * `defined` does not hold, as if it were defined.
 */
const withNotes = (text: string, defined: Defined): Defined => {
  let notes = defined;
  for (
    let at = text.indexOf("[^");
    at !== -1;
    at = text.indexOf("[^", at + 2)
  ) {
    let end = at + 2;
    while (end - at <= MAX_NOTE && !"[]\n\r\t ".includes(text[end] ?? "]")) {
      end += 1;
    }
    if (text[end] === "]" && end > at + 2 && text[end + 1] !== ":") {
      notes = notes === defined ? new Map(defined) : notes;
      define(notes, text.slice(at + 1, end), -1);
    }
  }
  return notes;
};

/**
 * `kept` with the blocks of `read` but the last, read from `tail` with `budget`, the last starting
 * at `cut`: their source, the names they define, and what is left of the budget once the last has
 * what it spent given back, as it is read again.
 */
const keptWith = (
  kept: Kept,
  tail: string,
  read: Placed[],
  budget: Budget,
  cut: number
): Kept => {
  const defined = new Map(kept.defined);
  for (const { node } of read.slice(0, -1)) {
    if (node.type === "definition" || node.type === "footnoteDefinition") {
      define(defined, definedAt(tail, startOf(node), true) ?? "", -1);
    }
  }
  let { left } = budget;
  for (const [at, cost] of budget.charged) {
    left += at >= cut ? cost : 0;
  }
  return {
    ...kept,
    text: kept.text + tail.slice(0, cut),
    blocks: [...kept.blocks, ...read.slice(0, -1)],
    defined,
    left,
  };
};

/**
 * The blocks of `shown`, given what was kept from reading less of it, and what to keep now. `kept`
 * comes back as it was given when nothing more is finished. Once the answer is written (not
 * `live`), it is read whole, as it is when the page is opened again: the same budgets spent in the
 * same places, the same notes and references.
 */
export const readBlocks = (
  shown: string,
  kept: Kept,
  live = true
): { blocks: Placed[]; kept: Kept } => {
  if (!live) {
    const blocks = parseMarkdown(shown).children.map((node) => ({
      node,
      base: 0,
    }));
    return { blocks, kept };
  }
  // Other words than those kept (a new answer in the same place): start again.
  const held = shown.startsWith(kept.text) ? kept : NOTHING;
  const base = held.text.length;
  const tail = shown.slice(base);
  const budget: Budget = {
    left: held.left ?? MAX_COST,
    charged: [],
    spent: (held.spent ?? Number.POSITIVE_INFINITY) - base,
    shift: 0,
    names: FREE_MARKS,
  };
  const defined = held.defined ?? new Map();
  const read = guarded(tail, budget, withNotes(tail, defined)).children.map(
    (node) => ({ node, base })
  );
  const blocks = [...held.blocks, ...read];
  const cut = read.at(-1)?.node.position?.start.offset;
  const spent = budget.spent + base;
  const now =
    spent === (held.spent ?? Number.POSITIVE_INFINITY)
      ? held
      : { ...held, spent };
  // Every block but the last is finished: kept, with the source up to where the last starts. Not
  // while lines are plain for want of budget: they are read again with what stands before them.
  if (
    read.length > 1 &&
    cut !== undefined &&
    cut > 0 &&
    !read.some(({ node }) => PLAIN.has(node))
  ) {
    return { blocks, kept: keptWith(now, tail, read, budget, cut) };
  }
  return { blocks, kept: now };
};

// ---- Sections: the one HTML form drawn as what it means ----------------------------------------------
//
// A collapsible section in the one form GitHub renders:
//
//   <details>                                (or with attributes: `<details open>` stands open)
//   <summary>The policy's limits</summary>
//
//   - Meals: €40 a day.
//
//   </details>
//
// CommonMark reads that as three things: an HTML block holding the opening and the summary, the
// Markdown blocks of its body, and an HTML block holding the closing. Only this form is read again,
// as a section with its summary and the blocks between; any other HTML stays text. While an answer
// is written, an opening is a section from the moment it is whole (repair holds it back till then),
// its closing still to come, and so it stays once the answer is tidied (`truncated`). An answer
// drawn whole with an opening nothing closes shows it as text, and so does a stream that ended so.
// Sections may hold sections.

const isWhite = (char: string | undefined) =>
  char !== undefined && /\s/u.test(char);

/**
 * A section's opening (Sections, below), read: `<details>` and its attributes, then its
 * `<summary>` on the next line or the same one, and nothing after; or null.
 */
const openingOf = (
  text: string
): { attributes: string; summary: string } | null => {
  if (!text.startsWith("<details")) {
    return null;
  }
  let at = "<details".length;
  for (;;) {
    let name = at;
    while (isWhite(text[name])) {
      name += 1;
    }
    if (name === at || !/^[a-z]$/u.test(text[name] ?? "")) {
      break;
    }
    let end = name + 1;
    while (/^[a-z-]$/u.test(text[end] ?? "")) {
      end += 1;
    }
    if (text.startsWith('="', end)) {
      const quote = text.indexOf('"', end + 2);
      if (quote === -1 || text.slice(end, quote).includes("\n")) {
        return null;
      }
      end = quote + 1;
    }
    at = end;
  }
  let close = at;
  while (isWhite(text[close])) {
    close += 1;
  }
  let summary = blankFrom(text, close + 1);
  summary = blankFrom(text, summary + (text[summary] === "\n" ? 1 : 0));
  if (text[close] !== ">" || !text.startsWith("<summary>", summary)) {
    return null;
  }
  let end = text.length;
  while (isSpaceOrTab(text[end - 1])) {
    end -= 1;
  }
  const words = text.slice(summary + "<summary>".length, end);
  return words.endsWith("</summary>") && !words.includes("\n")
    ? {
        attributes: text.slice("<details".length, at),
        summary: words.slice(0, -"</summary>".length),
      }
    : null;
};
const CLOSING = /^<\/details>[ \t]*$/u;

/** One block of the answer, or a section holding its own. */
export type Grouped =
  | { type: "block"; placed: Placed }
  | {
      type: "section";
      summary: PhrasingContent[];
      summaryText: string;
      open: boolean;
      children: Grouped[];
      key: Placed;
    };

const htmlOf = (placed: Placed): string | null =>
  placed.node.type === "html" ? placed.node.value.trim() : null;

/** The summary's words, read as Markdown's inline text (bold, code, links), as GitHub reads them. */
const summaryOf = (text: string): PhrasingContent[] => {
  const [first] = parseMarkdown(text).children;
  return first?.type === "paragraph" ? first.children : [];
};

interface Frame {
  opening: NonNullable<ReturnType<typeof openingOf>>;
  key: Placed;
  children: Grouped[];
}

const sectionOf = ({ opening, key, children }: Frame): Grouped => {
  const summaryText = opening.summary.trim();
  return {
    type: "section",
    summary: summaryOf(summaryText),
    summaryText,
    // `<details open>` stands open at first, as GitHub draws it.
    open: /(?:^|\s)open(?:\s|=|$)/u.test(opening.attributes),
    children,
    key,
  };
};

/**
 * The answer's blocks, with every whole section read as one: each closing closes the latest opening
 * still open, in one pass; with `unclosed`, an opening nothing closes is a section too. Sections nest
 * at most MAX_DEPTH deep; an opening past that is text, and so is the closing that answers it.
 */
export const groupSections = (
  blocks: readonly Placed[],
  unclosed = false
): Grouped[] => {
  const root: Grouped[] = [];
  const open: Frame[] = [];
  let past = 0;
  const into = () => open.at(-1)?.children ?? root;
  for (const block of blocks) {
    const html = htmlOf(block);
    const opening = html === null ? null : openingOf(html);
    const frame = open.length > 0 && past === 0 ? open.at(-1) : undefined;
    if (opening !== null && open.length < MAX_DEPTH) {
      open.push({ opening, key: block, children: [] });
    } else if (html !== null && CLOSING.test(html) && frame !== undefined) {
      open.pop();
      into().push(sectionOf(frame));
    } else {
      if (opening !== null) {
        past += 1;
      } else if (html !== null && CLOSING.test(html) && past > 0) {
        past -= 1;
      }
      into().push({ type: "block", placed: block });
    }
  }
  // An opening nothing closed is text, and its blocks stand where they are, unless `unclosed`.
  for (let frame = open.pop(); frame !== undefined; frame = open.pop()) {
    if (unclosed) {
      into().push(sectionOf(frame));
    } else {
      into().push({ type: "block", placed: frame.key }, ...frame.children);
    }
  }
  return root;
};

/** What a section's opening or closing says as it arrives: its summary, or nothing; other HTML its text. */
export const sectionSaid = (value: string): string => {
  const [grouped] = groupSections([
    { node: { type: "html", value }, base: 0 },
    { node: { type: "html", value: "</details>" }, base: 0 },
  ]);
  if (grouped?.type === "section") {
    return grouped.summaryText;
  }
  return CLOSING.test(value.trim()) ? "" : value;
};
