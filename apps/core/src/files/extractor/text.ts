import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

// Text files and web pages as Markdown, beside the Office and PDF readers
// (formats.ts). Like them, this runs only inside the extractor's sandbox
// (worker.ts).

const utf16LittleEndian = [0xff, 0xfe];
const utf16BigEndian = [0xfe, 0xff];

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((byte, index) => bytes[index] === byte);

/**
 * A text file's text: UTF-16 when it opens with that byte order mark, as
 * Windows saves "Unicode" text; else UTF-8; and where it isn't valid
 * UTF-8, Windows-1252, which older exports are in and which gives every
 * byte a character.
 */
export const decoded = (bytes: Uint8Array): string => {
  if (startsWith(bytes, utf16LittleEndian)) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (startsWith(bytes, utf16BigEndian)) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes
    );
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
};

/** Plain text or Markdown, as it is. */
export const textMarkdown = (bytes: Uint8Array): string =>
  decoded(bytes).trim();

const fenceRuns = /`+/gu;

/** `text` whole in one code block, fenced by more backticks than it holds in a row. */
const fenced = (text: string): string => {
  let longest = 2;
  for (const [run] of text.matchAll(fenceRuns)) {
    longest = Math.max(longest, run.length);
  }
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
};

/**
 * Data kept as text (JSON, XML, YAML), whole in one code block, so
 * none of it reads as Markdown: fenced by more backticks than it holds in
 * a row.
 */
export const dataMarkdown = (bytes: Uint8Array): string => {
  const text = decoded(bytes).trim();
  return text === "" ? "" : fenced(text);
};

type Node = DefaultTreeAdapterTypes.ChildNode;

/** Elements whose content is no text of the page. */
const unread: ReadonlySet<string> = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "head",
  "svg",
  "iframe",
  "object",
]);

/** Elements that start on a line of their own, with a blank line around them. */
const blocks: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tr",
  "ul",
]);

const headingLevels: Readonly<Record<string, number>> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const whitespace = /\s+/gu;
const spacesAroundBreak = / *\n */gu;
const blankLines = /\n{3,}/gu;

/** What a page's text is gathered into, a piece at a time. */
interface Page {
  pieces: string[];
  /**
   * Its preformatted blocks, as written: each stands in `pieces` as a
   * mark (`preMark`), put back as a code block once the rest is tidied,
   * so its own spaces and line breaks are left as they are.
   */
  pre: string[];
}

/**
 * Where a preformatted block stands until it is put back: between NUL
 * characters, which no parsed page holds (the HTML parser replaces them).
 */
const preMark = (at: number): string => `\0pre${at}\0`;
const preMarks = /\0pre(?<at>\d+)\0/gu;

/** The text under `nodes`, as written: what a preformatted block holds. */
const textOf = (nodes: readonly Node[]): string =>
  nodes
    .map((node) => {
      if (node.nodeName === "#text" && "value" in node) {
        return node.value;
      }
      if (!("tagName" in node) || unread.has(node.tagName)) {
        return "";
      }
      return node.tagName === "br" ? "\n" : textOf(node.childNodes);
    })
    .join("");

/** Whether an element is one a browser doesn't show: marked `hidden`. */
const isHidden = (element: DefaultTreeAdapterTypes.Element): boolean =>
  element.attrs.some(({ name }) => name === "hidden");

const breakParagraph = ({ pieces }: Page): void => {
  pieces.push("\n\n");
};

/**
 * Reads one element into `page`: a line break, a heading by its level, a
 * list item as one, a table's cells apart, a preformatted block as a mark
 * for its code block, any other block on lines of its own.
 */
const readElement = (
  { tagName, childNodes }: DefaultTreeAdapterTypes.Element,
  page: Page,
  /** Reads an element's children into the page, as the page itself is read. */
  within: (nodes: readonly Node[]) => void
): void => {
  const level = headingLevels[tagName];
  if (tagName === "br") {
    page.pieces.push("\n");
  } else if (tagName === "pre") {
    breakParagraph(page);
    page.pieces.push(preMark(page.pre.length));
    page.pre.push(textOf(childNodes));
    breakParagraph(page);
  } else if (level !== undefined) {
    breakParagraph(page);
    page.pieces.push(`${"#".repeat(level)} `);
    within(childNodes);
    breakParagraph(page);
  } else if (tagName === "li") {
    page.pieces.push("\n- ");
    within(childNodes);
    page.pieces.push("\n");
  } else if (tagName === "td" || tagName === "th") {
    within(childNodes);
    page.pieces.push(" | ");
  } else if (blocks.has(tagName)) {
    breakParagraph(page);
    within(childNodes);
    breakParagraph(page);
  } else {
    within(childNodes);
  }
};

/**
 * Reads `nodes` into `page`, in document order: text with its whitespace
 * collapsed as a browser shows it, and each element a browser shows
 * (`readElement`), none it hides.
 */
const read = (nodes: readonly Node[], page: Page): void => {
  for (const node of nodes) {
    if (node.nodeName === "#text" && "value" in node) {
      page.pieces.push(node.value.replaceAll(whitespace, " "));
    } else if (
      "tagName" in node &&
      !unread.has(node.tagName) &&
      !isHidden(node)
    ) {
      readElement(node, page, (children) => {
        read(children, page);
      });
    }
  }
};

/** The first element named `name` under `nodes`, if there is one. */
const find = (
  nodes: readonly Node[],
  name: string
): DefaultTreeAdapterTypes.Element | undefined => {
  for (const node of nodes) {
    if ("tagName" in node) {
      const found = node.tagName === name ? node : find(node.childNodes, name);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
};

/**
 * A web page's text, parsed as a browser parses it (parse5, the HTML
 * standard's own algorithm): its title as the first heading, then what
 * its body shows, without scripts, styles, what is marked hidden or
 * anything else a reader never sees. A preformatted block is a code
 * block, its spaces and line breaks as written.
 */
export const htmlMarkdown = (bytes: Uint8Array): string => {
  const { childNodes } = parse(decoded(bytes));
  const page: Page = { pieces: [], pre: [] };
  const title = find(childNodes, "title");
  if (title !== undefined) {
    page.pieces.push("# ");
    read(title.childNodes, page);
    breakParagraph(page);
  }
  const body = find(childNodes, "body");
  read(body === undefined ? [] : body.childNodes, page);
  return page.pieces
    .join("")
    .replaceAll(spacesAroundBreak, "\n")
    .replaceAll(blankLines, "\n\n")
    .trim()
    .replaceAll(preMarks, (_mark, at: string) =>
      fenced(page.pre[Number(at)] ?? "")
    );
};
