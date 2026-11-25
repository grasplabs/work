// Markdown's pure half: the answer cut into top-level blocks, each read once by micromark (with
// GitHub's additions) while it is the same, and the end still being written made whole by remend.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import remend from "remend";

/** A Markdown syntax tree (mdast). */
export type MarkdownRoot = ReturnType<typeof fromMarkdown>;
export type RootContent = MarkdownRoot["children"][number];

// Strike-through is two tildes, as a model writes it (`20~25°C` is a tilde). micromark weighs each
// emphasis or link mark of a paragraph against those before it, so many unmatched ones cost their
// number squared (`a*` repeated: 1.7 s for 40 KB): a block with a paragraph of more than 1,000 (its
// fenced code aside) is read without them, as words, and without `![^1]`, a note's mark after a `!`,
// which looks back for its picture.
const OFF =
  "attention strikethrough labelStartLink labelStartImage labelEnd gfmPotentialFootnoteCall";
const GFM = [gfm({ singleTilde: false })];
const PLAIN = [...GFM, { disable: { null: OFF.split(" ") } }];
const FROM = [gfmFromMarkdown()];
/** The names an answer defines, as the tree has them. */
export interface Names {
  links: readonly string[];
  notes: readonly string[];
}
const NO_NAMES: Names = { links: [], notes: [] };
// micromark reads `[label]` as a reference, and `[^label]` as a note's mark, only once it has read
// the definition in the same read: its parse context's `defined` (micromark's own) and
// `gfmFootnotes` (the footnote extension's) say which. No option sets them, so a block read alone
// is told the names the whole answer defines by a construct that runs first at each `[` or `!`
// and widens both lists. scripts/markdown.test.tsx ("a block read alone knows the answer's
// names") pins this.
const toldParsers = new WeakSet<object>();
const knows =
  (names: readonly string[], own: readonly string[]) => (id: string) =>
    names.includes(id.toLowerCase()) || own.includes(id);
const told = ({ links, notes }: Names) => {
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
        parser.defined.includes = knows(links, [...parser.defined]);
        parser.gfmFootnotes = Object.assign(own, {
          includes: knows(notes, [...own]),
        });
      }
      return nok;
    },
  };
  // Before a link's or a picture's first mark (`[`, `!`).
  return { text: { 33: construct, 91: construct } };
};
const FENCE = /^ {0,3}(?<fence>`{3,}|~{3,})(?<info>.*)$/u;
const closes = (line: string, open: string) => {
  const { fence = "", info = "x" } = FENCE.exec(line)?.groups ?? {};
  return (
    fence.startsWith(open.slice(0, 1)) &&
    fence.length >= open.length &&
    info.trim() === ""
  );
};
/** The fence open after `line`, `fence` the one open before it (`` when none). */
const fenceAfter = (fence: string, line: string) => {
  if (fence === "") {
    return FENCE.exec(line)?.groups?.fence ?? "";
  }
  return closes(line, fence) ? "" : fence;
};
// A line led by more than 64 characters of indent and container marks: a list or a quote nested
// past 32 deep, which micromark weighs as its depth squared (400 deep: 5 s for 80 KB).
const DEEP = /^(?:[ \t]|(?:[-*+>]|\d{1,9}[.)])(?=[ \t])){65,}/u;
/**
 * The source as it is read, fenced code left as it is: a line nested past 32 deep keeps its last 64
 * characters of lead, so it is drawn 32 deep; and whether a paragraph has more than 1,000 marks.
 */
const bounded = (source: string) => {
  let fence = "";
  let marks = 0;
  let many = false;
  const out: string[] = [];
  for (const [at, line] of source.split("\n").entries()) {
    const was = fence;
    fence = fenceAfter(was, line);
    // A fence, a list item, a row, a heading or a blank line starts a part of its own.
    const starts = fence !== "" || /^[ \t>]*(?:[-*+|#\d]|$)/u.test(line);
    marks = (starts ? 0 : marks) + line.replaceAll(/[^*_~[\]]/gu, "").length;
    many ||= was === "" && marks > 1000;
    out.push(
      at === 0 ? "" : "\n",
      was === "" ? line.replace(DEEP, (lead) => lead.slice(-64)) : line
    );
  }
  return { text: out.join(""), many };
};
const read = (source: string, names = NO_NAMES): MarkdownRoot => {
  const { text, many } = bounded(source);
  try {
    const extensions = [...(many ? PLAIN : GFM), told(names)];
    return fromMarkdown(text, { extensions, mdastExtensions: FROM });
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
// fence, HTML that may hold blank lines (CommonMark's kinds 1 to 5) and a section run on to their
// end.
const STARTS = /^(?![-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))\S/u;
const HTML =
  /^ {0,3}<(?<open>pre|script|style|textarea|!--|\?|!\[CDATA\[|![a-z])/iu;
const ENDS: Record<string, string> = {
  "!--": "-->",
  "?": "?>",
  "![cdata[": "]]>",
};

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
  const fence = FENCE.exec(line)?.groups?.fence;
  if (fence !== undefined) {
    return until((next) => closes(next, fence));
  }
  if (OPENS.test(line)) {
    return sectionEnd(1, "");
  }
  const open = HTML.exec(line)?.groups?.open?.toLowerCase() ?? "";
  const end = ENDS[open] ?? (/^[a-z]{2}/u.test(open) ? `</${open}>` : ">");
  const ends = (next: string) => next.toLowerCase().includes(end);
  return open === "" || ends(line.slice(open.length + 1)) ? null : until(ends);
};

/** Where each top-level block starts, and where the scan may go on from: before a line still growing. */
export interface Cut {
  starts: number[];
  at: number;
  count: number;
  end: End | null;
  blank: boolean;
  run: number;
}
const FIRST: Cut = {
  starts: [0],
  at: 0,
  count: 1,
  end: null,
  blank: false,
  run: 0,
};
/** Where each top-level block of `source` starts, the scan going on from `from` (a shorter one's). */
export const blockStarts = (source: string, from = FIRST): Cut => {
  const starts = from.starts.slice(0, from.count);
  let { at, end, blank, run } = from;
  let kept = { ...from, starts };
  while (at < source.length) {
    const next = source.indexOf("\n", at) + 1 || source.length;
    const line = source.slice(at, next).trimEnd();
    if (end === null) {
      // A paragraph of more than 1,000 lines goes on as another: micromark weighs a paragraph's
      // lines as their number squared, and the block being written is read again as it grows.
      run = STARTS.test(line) && /^[^>|<]/u.test(line) ? run + 1 : 0;
      const starting = blank ? STARTS.test(line) : run > 1000;
      if (starting && at > (starts.at(-1) ?? 0)) {
        starts.push(at);
        run = 1;
      }
      end = endOf(line);
    } else {
      end = end(line);
    }
    blank = end === null && line === "";
    at = next;
    if (source.charAt(next - 1) === "\n") {
      kept = { starts, at, count: starts.length, end, blank, run };
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
  const { fence, info = "" } = FENCE.exec(first)?.groups ?? {};
  if (fence === undefined || lines.some((line) => closes(line, fence))) {
    return null;
  }
  const last = lines.at(-1)?.trim() ?? "";
  const lang = info.trim().split(/\s/u)[0] ?? "";
  const closing = last !== "" && fence.startsWith(last);
  const value = (closing ? lines.slice(0, -1) : lines).join("\n");
  return [{ type: "code" as const, lang: lang === "" ? null : lang, value }];
};

const REPAIR = {
  singleTilde: false,
  comparisonOperators: false,
  katex: false,
} as const;
/**
 * The block still being written made whole (remend: bold from its first letter, a half link one to
 * nowhere, a half picture's address nowhere), with none of its rewrites that would draw a whole
 * answer otherwise. remend closes no emphasis opened before the half link it ends in, so that is
 * closed after it, as remend closes it for the words before.
 */
const repair = (block: string) => {
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
/**
 * A table from a model has no bound: past its first 1,000 rows, only how many more there are is
 * read (`more` on the table).
 */
const lessRows = (block: string) => {
  const head = block.indexOf("\n");
  const second = block.indexOf("\n", head + 1);
  const dashes = block.slice(head + 1, second === -1 ? undefined : second);
  let cut = head;
  for (let row = 0; row <= 1000 && cut !== -1; row += 1) {
    cut = block.indexOf("\n", cut + 1);
  }
  const table =
    head !== -1 && block.slice(0, head).includes("|") && DASH_ROW.test(dashes);
  if (!table || cut === -1) {
    return { text: block, more: 0 };
  }
  const rest = block.slice(cut + 1).split("\n");
  return {
    text: block.slice(0, cut),
    more: rest.filter((line) => line.trim() !== "").length,
  };
};

// Blocks read once, while the same, up to 2 MB of their source in all: past that, the ones used
// longest ago go first, but never one used in this pass (since the answer being drawn began its
// reads, `nextPass`), so an answer that needs more keeps what it reads now.
const cache = new Map<string, { nodes: Block[]; pass: number }>();
let cached = 0;
let pass = 0;
/** Starts a pass: an answer is about to read its blocks. */
export const nextPass = () => {
  pass += 1;
};

/** A block's nodes, read once while it is the same; the block still being written is not kept. */
export const readBlock = (block: string, reading: Reading = {}): Block[] => {
  const { open = false, names = NO_NAMES, depth = 0 } = reading;
  // A section read inside others stops at 32 deep, so how deep it is read is part of the key.
  const key = `${depth} ${JSON.stringify(names)}${block}`;
  const known = open ? undefined : cache.get(key);
  if (known !== undefined) {
    // Used again: the newest.
    cache.delete(key);
    cache.set(key, { nodes: known.nodes, pass });
    return known.nodes;
  }
  const { text, more } = lessRows(open ? repair(block) : block);
  const nodes =
    sectionOf(text, reading, readBlock) ?? read(text, names).children;
  const [table] = nodes;
  if (more > 0 && table?.type === "table") {
    Object.assign(table, { more });
  }
  if (!open) {
    cache.set(key, { nodes, pass });
    cached += key.length;
    for (const [old, entry] of cache) {
      if (cached <= 2_000_000 || entry.pass === pass) {
        break;
      }
      cache.delete(old);
      cached -= old.length;
    }
  }
  return nodes;
};

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
