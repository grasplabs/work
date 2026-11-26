// Markdown's pure half: the answer cut into top-level blocks, each read once by micromark (with
// GitHub's additions) while it is the same, and the end still being written made whole by remend.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import remend from "remend";

/** A Markdown syntax tree (mdast). */
export type MarkdownRoot = ReturnType<typeof fromMarkdown>;
export type RootContent = MarkdownRoot["children"][number];

// Strike-through is two tildes, as a model writes it (`20~25°C` is a tilde); maths is between two
// dollars, as Streamdown reads it (`$5 and $6` are prices), in a sentence or as lines of its own.
// micromark weighs each emphasis or link mark of a paragraph against those before it, so many
// unmatched ones cost their number squared (`a*` repeated: 1.7 s for 40 KB): a block with a
// paragraph of more than 1,000, or with more than 5,000 in all (its fenced code aside), is read
// without them, as words, and without `![^1]`, a note's mark after a `!`, which looks back for its
// picture. A paragraph is counted from each line that may start a part, so the total holds where
// such a line only goes on with it (`1a*a*…` lines: 19 s for 80 KB).
const MARKS =
  "attention strikethrough labelStartLink labelStartImage labelEnd gfmPotentialFootnoteCall".split(
    " "
  );
// micromark, then the tree's own pass for bare addresses, read a bare address again from each place
// one may start to the end of its word, which only a space, a tab or a line's end ends (`www.a_`
// repeated: 3 s for 24 KB): a block with a word of more than 1,000 characters (its fenced code
// aside) is read without bare addresses.
const ADDRESSES = ["wwwAutolink", "protocolAutolink", "emailAutolink"];
// HTML is never drawn: a tag (an open or closing tag, a comment) is read where it stands, inside a
// line, and dropped (markdown.tsx), so a tag on a line of its own is not an HTML block that would
// run on to the next blank line, and the lines after it are Markdown. An address in angle brackets
// (`<https://…>`) is an autolink, not HTML: it stays a link.
const HTML = ["htmlFlow"];
const GFM = gfm({ singleTilde: false });
const MATH = math({ singleDollarTextMath: false });
const MATH_FROM = mathFromMarkdown();
const FROM = gfmFromMarkdown();
const NO_ADDRESSES = FROM.map((extension) => ({
  ...extension,
  transforms: [],
}));
/** The names an answer defines, as the tree has them. */
export interface Names {
  links: ReadonlySet<string>;
  notes: ReadonlySet<string>;
}
const NO_NAMES: Names = { links: new Set(), notes: new Set() };
/** A name a read asked the answer about, and whether the answer defined it then. */
type Asked = readonly [kind: keyof Names, name: string, defined: boolean];
// micromark reads `[label]` as a reference, and `[^label]` as a note's mark, only once it has read
// the definition in the same read: its parse context's `defined` (micromark's own) and
// `gfmFootnotes` (the footnote extension's) say which. No option sets them, so a block read alone
// is told the names the whole answer defines by a construct that runs first at each `[` or `!`
// and widens both lists; each name it is asked about is noted in `asked`, all its tree depends on.
// scripts/markdown.test.tsx ("a block read alone knows the answer's names") pins this.
const toldParsers = new WeakSet<object>();
const knows =
  (names: Names, kind: keyof Names, own: readonly string[], asked: Asked[]) =>
  (id: string) => {
    if (own.includes(id)) {
      return true;
    }
    const name = id.toLowerCase();
    const defined = names[kind].has(name);
    asked.push([kind, name, defined]);
    return defined;
  };
const told = (names: Names, asked: Asked[]) => {
  const construct = {
    add: "before" as const,
    tokenize<State>(
      this: { parser: { defined: string[]; gfmFootnotes?: string[] } },
      _: unknown,
      __: unknown,
      nok: State
    ) {
      const { parser } = this;
      if (!toldParsers.has(parser)) {
        toldParsers.add(parser);
        const own = parser.gfmFootnotes ?? [];
        parser.defined.includes = knows(
          names,
          "links",
          [...parser.defined],
          asked
        );
        parser.gfmFootnotes = Object.assign(own, {
          includes: knows(names, "notes", [...own], asked),
        });
      }
      return nok;
    },
  };
  // Before a link's or a picture's first mark (`[`, `!`).
  return { text: { 33: construct, 91: construct } };
};
// A fence: of code, or (`$$`) of maths, whose words after it hold no dollar (`$$x$$` is maths in a
// sentence).
const FENCE = /^ {0,3}(?<fence>`{3,}|~{3,}|\${2,})(?<info>.*)$/u;
const fenceOf = (line: string) => {
  const found = FENCE.exec(line)?.groups;
  return found?.fence?.startsWith("$") === true &&
    found.info?.includes("$") === true
    ? undefined
    : found;
};
const closes = (line: string, open: string) => {
  const { fence = "", info = "x" } = fenceOf(line) ?? {};
  return (
    fence.startsWith(open.slice(0, 1)) &&
    fence.length >= open.length &&
    info.trim() === ""
  );
};
/** The fence open after `line`, `fence` the one open before it (`` when none). */
const fenceAfter = (fence: string, line: string) => {
  if (fence === "") {
    return fenceOf(line)?.fence ?? "";
  }
  return closes(line, fence) ? "" : fence;
};
// A line led by more than 64 characters of indent and container marks: a list or a quote nested
// past 32 deep, which micromark weighs as its depth squared (400 deep: 5 s for 80 KB). A quote's
// `>` needs no space after it (`>- ` repeated).
const DEEP = /^(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])(?=[ \t])){65,}/u;
/**
 * The source as it is read, fenced code left as it is: a line nested past 32 deep keeps its last 64
 * characters of lead, so it is drawn at most 64 deep; whether a paragraph has more than 1,000 marks
 * or the block more than 5,000 (`many`), and whether a word has more than 1,000 characters (`long`).
 */
const bounded = (source: string) => {
  let fence = "";
  let marks = 0;
  let total = 0;
  let many = false;
  let long = false;
  const out: string[] = [];
  for (const [at, line] of source.split("\n").entries()) {
    const was = fence;
    fence = fenceAfter(was, line);
    // A fence, a list item, a row, a heading or a blank line starts a part of its own.
    const starts = fence !== "" || /^[ \t>]*(?:[-*+|#\d]|$)/u.test(line);
    const count = line.replaceAll(/[^*_~[\]]/gu, "").length;
    marks = (starts ? 0 : marks) + count;
    total += was === "" ? count : 0;
    many ||= was === "" && (marks > 1000 || total > 5000);
    long ||=
      was === "" && line.split(/[\t\r ]/u).some((word) => word.length > 1000);
    out.push(
      at === 0 ? "" : "\n",
      was === "" ? line.replace(DEEP, (lead) => lead.slice(-64)) : line
    );
  }
  return { text: out.join(""), many, long };
};
const read = (
  source: string,
  names = NO_NAMES,
  asked: Asked[] = []
): MarkdownRoot => {
  const { text, many, long } = bounded(source);
  try {
    const off = [...HTML, ...(many ? MARKS : []), ...(long ? ADDRESSES : [])];
    const extensions = [
      GFM,
      MATH,
      { disable: { null: off } },
      told(names, asked),
    ];
    const mdastExtensions = [...(long ? NO_ADDRESSES : FROM), MATH_FROM];
    return fromMarkdown(text, { extensions, mdastExtensions });
  } catch {
    // Nesting deep enough to exhaust the stack (thousands of `>` on a line): its words.
    const words = { type: "text" as const, value: source };
    return {
      type: "root",
      children: [{ type: "paragraph", children: [words] }],
    };
  }
};
/** An answer's syntax tree, whole. */
export const parseMarkdown = (source: string) => read(source);

// After a blank line, a line at the margin that no list item starts starts a block of its own; a
// fence and a section run on to their end.
const STARTS = /^(?![-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))\S/u;

const OPENS = /^<details\b/iu;
const CLOSES = /^<\/details>[ \t]*$/iu;
/** What a block still open waits for: given its next line, what it then waits for, or null once it ends. */
type End = (next: string) => End | null;
const until = (ends: (next: string) => boolean): End => {
  const end: End = (next) => (ends(next) ? null : end);
  return end;
};
/** A section's end: the `</details>` that closes its `<details>`, fenced code aside. */
const sectionEnd =
  (depth: number, fence: string): End =>
  (next) => {
    if (fence !== "") {
      return sectionEnd(depth, fenceAfter(fence, next));
    }
    const now = depth + Number(OPENS.test(next)) - Number(CLOSES.test(next));
    return now === 0 ? null : sectionEnd(now, fenceAfter("", next));
  };

/** What ends the block `line` opens, if it does not end on that line. */
const endOf = (line: string): End | null => {
  const fence = fenceOf(line)?.fence;
  if (fence !== undefined) {
    return until((next) => closes(next, fence));
  }
  return OPENS.test(line) ? sectionEnd(1, "") : null;
};

/** Where each top-level block starts, and where the scan may go on from: before a line still growing. */
export interface Cut {
  starts: number[];
  at: number;
  count: number;
  end: End | null;
  blank: boolean;
  run: number;
  lines: number;
}
const FIRST: Cut = {
  starts: [0],
  at: 0,
  count: 1,
  end: null,
  blank: false,
  run: 0,
  lines: 0,
};
const ITEM = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\S/u;
/** Where each top-level block of `source` starts, the scan going on from `from` (a shorter one's). */
export const blockStarts = (source: string, from = FIRST): Cut => {
  const starts = from.starts.slice(0, from.count);
  let { at, end, blank, run, lines } = from;
  let kept = { ...from, starts };
  while (at < source.length) {
    const next = source.indexOf("\n", at) + 1 || source.length;
    const line = source.slice(at, next).trimEnd();
    if (end === null) {
      // A paragraph of more than 1,000 lines goes on as another, and so does a list at its next
      // item: micromark weighs a paragraph's lines, and a list's items that hold lists, as their
      // number squared (`- - a` 4,000 times: 1 s), and the block being written is read again as it
      // grows.
      run = STARTS.test(line) && /^[^>|<]/u.test(line) ? run + 1 : 0;
      lines += 1;
      const starting = blank
        ? STARTS.test(line)
        : run > 1000 || (lines > 1000 && ITEM.test(line));
      if (starting && at > (starts.at(-1) ?? 0)) {
        starts.push(at);
        run = 1;
        lines = 1;
      }
      end = endOf(line);
    } else {
      end = end(line);
    }
    blank = end === null && line === "";
    at = next;
    if (source.charAt(next - 1) === "\n") {
      kept = { starts, at, count: starts.length, end, blank, run, lines };
    }
  }
  return { ...kept, starts };
};

/** Whether `text` ends inside fenced code that is still open. */
export const inOpenFence = (text: string) => {
  let fence = "";
  for (const line of text.split("\n")) {
    // A fence may open inside a quote or a list item.
    const bare = line.replace(/^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?/u, "");
    fence = fenceAfter(fence, bare);
  }
  return fence !== "";
};

/**
 * A block that opens a fence and does not close it: its code, never read by the parser, less a
 * closing fence still being typed.
 */
export const openCode = (block: string) => {
  const [first = "", ...lines] = block.split("\n");
  const { fence, info = "" } = fenceOf(first) ?? {};
  // Maths still being written is read, made whole by remend.
  if (
    fence === undefined ||
    fence.startsWith("$") ||
    lines.some((line) => closes(line, fence))
  ) {
    return null;
  }
  const last = lines.at(-1)?.trim() ?? "";
  const lang = info.trim().split(/\s/u)[0] ?? "";
  const closing = last !== "" && fence.startsWith(last);
  const value = (closing ? lines.slice(0, -1) : lines).join("\n");
  return [{ type: "code" as const, lang: lang === "" ? null : lang, value }];
};

// A tag is drawn as its words (`html`), so one still open is too: remend would hide all after it.
const REPAIR = {
  singleTilde: false,
  comparisonOperators: false,
  htmlTags: false,
} as const;
/**
 * The block still being written made whole (remend: bold from its first letter, a half link one to
 * nowhere, a half picture's address nowhere, maths closed), with none of its rewrites that would draw a whole
 * answer otherwise. remend closes no emphasis opened before the half link it ends in, so that is
 * closed after it, as remend closes it for the words before.
 */
const repair = (block: string) => {
  // remend 1.5.0 heals brackets nested n deep in n² (16,000 deep: 1.2 s); 1.5.1 heals them in
  // linear time. Until then a block with more than 1,000 `[` is drawn as written.
  if (block.split("[").length > 1001) {
    return block;
  }
  // An address whose parentheses balance (`…_(format)`) is still open: remend would take its first
  // `)` for the link's end, so it is cut back to its `](`, a half link.
  const at = block.lastIndexOf("](");
  const address = block.slice(at + 2);
  const parens = address.split("(").length - address.split(")").length;
  const open =
    at !== -1 && !/\s/u.test(address) && address.includes(")") && parens >= 0;
  const whole = remend(open ? block.slice(0, at + 2) : block, REPAIR);
  const end = whole.lastIndexOf("](streamdown:incomplete-");
  if (end === -1 || whole.indexOf(")", end) !== whole.length - 1) {
    return whole;
  }
  // The half link's own `[`: the one its `]` closes, brackets inside its words aside.
  let label = end;
  for (let depth = 0; label > 0 && depth >= 0;) {
    label -= 1;
    depth += Number(whole[label] === "]") - Number(whole[label] === "[");
  }
  const before = whole.slice(0, label).replace(/!$/u, "");
  const closed = remend(`${before}x`, REPAIR);
  // Only its emphasis: a bracket still open before it is words, never a second half link.
  const marks = closed
    .slice(before.length + 1)
    .replace(/\]\(streamdown:incomplete-\w+\)/u, "");
  return closed.startsWith(`${before}x`) ? whole + marks : whole;
};

/**
 * A section: `<details>` with its `<summary>` line, its body read as blocks of its own; with where
 * its summary and each of its blocks start in its source (their positions are their own).
 */
export interface Section {
  type: "section";
  summary: string;
  open: boolean;
  children: Block[];
  starts: { summary: number; children: number[] };
  position?: undefined;
}
export type Block = RootContent | Section;
/** How a block is read: still being written (`open`), with the names the answer defines. */
export interface Reading {
  open?: boolean;
  names?: Names;
  depth?: number;
}
const OPENING =
  /^<details(?<attributes>(?:\s+[a-z][a-z-]*(?:="[^"\n]*")?)*)\s*>[ \t]*\n?[ \t]*<summary>(?<summary>[^\n]*)<\/summary>[ \t]*(?:\n|$)/u;
/**
 * A section, nested at most 32 deep; once written, only one that closes (an answer drawn whole
 * with an opening nothing closes shows it as text). While written, its opening waits until whole.
 */
const sectionOf = (
  block: string,
  reading: Reading,
  readChild: (text: string, reading: Reading) => Block[]
): Block[] | null => {
  const { depth = 0, open = false } = reading;
  const opening = OPENING.exec(block);
  if (opening === null) {
    return open && OPENS.test(block) ? [] : null;
  }
  const body = block.slice(opening[0].length).trimEnd();
  // Closed by its own `</details>`, not by a section's inside it (fenced code aside).
  let end: End | null = sectionEnd(1, "");
  for (const line of body.split("\n")) {
    end = end?.(line) ?? null;
  }
  const closed = end === null && /(?:^|\n)<\/details>$/u.test(body);
  if (depth >= 32 || !(closed || open)) {
    return null;
  }
  const { attributes = "", summary = "" } = opening.groups ?? {};
  const inner = closed ? body.slice(0, body.lastIndexOf("</details>")) : body;
  const { starts } = blockStarts(inner);
  const children = starts.flatMap((start, at) => {
    const last = open && !closed && at === starts.length - 1;
    const text = inner.slice(start, starts[at + 1]);
    const blocks =
      (last ? openCode(text) : null) ??
      readChild(text, { ...reading, open: last, depth: depth + 1 });
    return blocks.map((child) => [opening[0].length + start, child] as const);
  });
  const lead = opening[0].indexOf("<summary>") + 9;
  return [
    {
      type: "section",
      summary: summary.trim(),
      open: /(?:^|\s)open(?:\s|=|$)/u.test(attributes),
      children: children.map(([, child]) => child),
      starts: {
        summary: lead + summary.length - summary.trimStart().length,
        children: children.map(([at]) => at),
      },
    },
  ];
};

const DASH_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\||$)/u;
// What ends a table's rows, as micromark reads them: a blank line, or a line that starts a heading,
// a quote, a list item, a break, indented code, a fence, or a section.
const ROWS_END =
  /^(?:[ \t]*$| {0,3}\t| {4}| {0,3}(?:#{1,6}(?:[ \t]|$)|>|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|(?<mark>[-*_])(?:[ \t]*\k<mark>){2,}[ \t]*$))/u;
const endsRows = (line: string) => {
  // A backtick fence's info has no backtick: ``` `a` ``` is code in a row.
  const { fence = "", info = "" } = FENCE.exec(line)?.groups ?? {};
  const fenced = fence !== "" && !(fence.startsWith("`") && info.includes("`"));
  return ROWS_END.test(line) || fenced || OPENS.test(line);
};
/**
 * A table from a model has no bound: past its first 1,000 rows, only how many more there are is
 * read (`more` on the table); what follows the table is read as written.
 */
const lessRows = (block: string) => {
  const head = block.indexOf("\n");
  const second = block.indexOf("\n", head + 1);
  const dashes = block.slice(head + 1, second === -1 ? undefined : second);
  const table =
    head !== -1 && block.slice(0, head).includes("|") && DASH_ROW.test(dashes);
  if (!table) {
    return { text: block, more: 0 };
  }
  const lines = block.split("\n");
  const end = lines.findIndex((line, at) => at > 1 && endsRows(line));
  const rows = (end === -1 ? lines.length : end) - 2;
  if (rows <= 1000) {
    return { text: block, more: 0 };
  }
  const after = end === -1 ? [] : lines.slice(end);
  return {
    text: [...lines.slice(0, 1002), ...after].join("\n"),
    more: rows - 1000,
  };
};

interface Entry {
  nodes: Block[];
  asked: readonly Asked[];
}
/**
 * One Markdown's readings of its blocks, each kept while the block is the same and each name its
 * read asked about is defined or not as it was: those its last render read (`kept`), and those
 * the render under way has read (`read`). `settle` keeps only the latter, so a Markdown holds the
 * readings of the text it draws, and lets them go with it.
 */
export interface Reads {
  kept: Map<string, Entry>;
  read: Map<string, Entry>;
}
export const newReads = (): Reads => ({ kept: new Map(), read: new Map() });
/** A render is drawn: what it did not read goes. */
export const settle = (reads: Reads) => {
  reads.kept = reads.read;
  reads.read = new Map();
};

/** A section's reads ask what its blocks' reads asked. */
const tell = (into: Asked[], asked: readonly Asked[]) => {
  for (const one of asked) {
    into.push(one);
  }
};
const readInto = (
  block: string,
  reading: Reading,
  reads: Reads | undefined,
  into: Asked[]
): Block[] => {
  const { open = false, names = NO_NAMES, depth = 0 } = reading;
  // A section read inside others stops at 32 deep, so how deep it is read is part of the key.
  const key = `${depth} ${block}`;
  const known = open
    ? undefined
    : (reads?.read.get(key) ?? reads?.kept.get(key));
  if (
    known !== undefined &&
    known.asked.every(([kind, name, was]) => names[kind].has(name) === was)
  ) {
    reads?.read.set(key, known);
    tell(into, known.asked);
    return known.nodes;
  }
  const asked: Asked[] = [];
  const { text, more } = lessRows(open ? repair(block) : block);
  const nodes =
    sectionOf(text, reading, (child, inner) =>
      readInto(child, inner, reads, asked)
    ) ?? read(text, names, asked).children;
  const [table] = nodes;
  if (more > 0 && table?.type === "table") {
    Object.assign(table, { more });
  }
  tell(into, asked);
  if (!open) {
    reads?.read.set(key, { nodes, asked });
  }
  return nodes;
};
/**
 * A block's nodes, read once into `reads` while it is the same and the names it asked about are as
 * they were; the block still being written is not kept.
 */
export const readBlock = (
  block: string,
  reading: Reading = {},
  reads?: Reads
): Block[] => readInto(block, reading, reads, []);
/**
 * A block's nodes for the definitions it holds, which no name changes: as last read, whatever names
 * that read was told, so finding the answer's names reads no block again.
 */
export const readDefinitions = (block: string, reads: Reads) =>
  (reads.read.get(`0 ${block}`) ?? reads.kept.get(`0 ${block}`))?.nodes ??
  readBlock(block, {}, reads);

/**
 * An address as CommonMark writes it into a page: a character outside an address's own set is
 * percent-encoded, and an encoding already there is kept.
 */
export const encodedHref = (url: string) =>
  url.replaceAll(/%(?![\da-f]{2})|[^\w!#$&'()*+,./:;=?@~%-]/giu, (char) =>
    encodeURIComponent(char)
  );

/** Where a link or a picture still being written leads once remend has made it whole: nowhere. */
export const HALF = new Set([
  "streamdown:incomplete-link",
  "streamdown:incomplete-image",
]);
