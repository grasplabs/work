import { ToolError } from "@grasp-os/runtime/connector";
import { defaultTreeAdapter, html as htmlSpec, parse } from "parse5";
import type { DefaultTreeAdapterTypes, TreeAdapter } from "parse5";

/** A named entity or a character reference, `&amp;`, `&#8364;`, `&#x20AC;`. */
const reference = /&(?:#x(?<hex>[\da-fA-F]+)|#(?<decimal>\d+)|(?<name>\w+));/gu;

/** The highest code point. */
const maxCodePoint = 0x10_ff_ff;

const characterOf = (
  whole: string,
  { hex, decimal, name }: Partial<Record<"hex" | "decimal" | "name", string>>,
  names: Readonly<Record<string, string>>
): string => {
  if (name !== undefined) {
    return names[name] ?? whole;
  }
  const code = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
  return code > 0 && code <= maxCodePoint ? String.fromCodePoint(code) : whole;
};

/**
 * `text` with its character references, and the entities `names` names,
 * as the characters they stand for; any other left as it is. For a
 * transcript's WebVTT: HTML and Word's XML are read by their parsers.
 */
export const decoded = (
  text: string,
  names: Readonly<Record<string, string>>
): string => {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(reference)) {
    out += text.slice(last, match.index);
    out += characterOf(match[0], match.groups ?? {}, names);
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
};

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

/**
 * Elements whose content a browser never shows, by their namespace: what
 * a page or a formula runs or is styled with, a page's head and title,
 * what stands in for scripts, frames, objects, media and widgets, a list
 * of suggestions; a formula's annotations and phantoms. A template's
 * content is outside the tree already.
 */
const unread: Readonly<Record<string, ReadonlySet<string>>> = {
  [htmlSpec.NS.HTML]: new Set([
    "script",
    "style",
    "head",
    "title",
    "noscript",
    "iframe",
    "noembed",
    "noframes",
    "audio",
    "video",
    "canvas",
    "object",
    "datalist",
    "meter",
    "progress",
    "rp",
  ]),
  [htmlSpec.NS.MATHML]: new Set([
    "script",
    "style",
    "annotation",
    "annotation-xml",
    "mphantom",
  ]),
};

const hasAttribute = ({ attrs }: Element, attribute: string): boolean =>
  attrs.some(({ name }) => name === attribute);

const isHtml = ({ namespaceURI }: Element): boolean =>
  namespaceURI === htmlSpec.NS.HTML;

/**
 * Whether a browser hides `element` and all it holds. A drawing (SVG) is
 * read as an image is, for none of its text: which of its characters a
 * browser draws turns on its structure, conditions and styles, more than
 * a reader can follow without passing hidden text for shown.
 */
const isUnread = (element: Element): boolean =>
  element.namespaceURI === htmlSpec.NS.SVG ||
  unread[element.namespaceURI]?.has(element.tagName) === true ||
  (isHtml(element) &&
    (hasAttribute(element, "hidden") ||
      hasAttribute(element, "popover") ||
      (element.tagName === "dialog" && !hasAttribute(element, "open"))));

/** Formula elements that show their first element alone (MathML Core). */
const firstShown: ReadonlySet<string> = new Set(["semantics", "maction"]);

/**
 * What a browser shows of what `element` holds: of a closed `details`,
 * only its first `summary`; of a formula's `semantics` or `maction`,
 * only its first element, whatever it is.
 */
const shownChildren = (element: Element): readonly Node[] => {
  let shown: Node | undefined;
  if (
    element.namespaceURI === htmlSpec.NS.MATHML &&
    firstShown.has(element.tagName)
  ) {
    shown = element.childNodes.find((node) => "tagName" in node);
  } else if (
    element.tagName === "details" &&
    isHtml(element) &&
    !hasAttribute(element, "open")
  ) {
    shown = element.childNodes.find(
      (node) => "tagName" in node && node.tagName === "summary"
    );
  } else {
    return element.childNodes;
  }
  return shown === undefined ? [] : [shown];
};

/** Elements on lines of their own: paragraphs, headings, list items, table rows, sections. */
const lineEnds: ReadonlySet<string> = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "address",
  "figure",
  "figcaption",
  "dl",
  "dt",
  "dd",
  "hr",
  "caption",
  "form",
  "fieldset",
  "center",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "tr",
  "table",
  "ul",
  "ol",
  "pre",
  "blockquote",
  "details",
  "summary",
]);

/**
 * The deepest an element may nest, as browsers bound it (Chromium's
 * parser, 512): HTML's tree construction looks through the elements open
 * around each tag, so markup nested deeper costs time by its depth
 * squared.
 */
const maxDepth = 512;

/**
 * Elements and their attributes per character of the HTML, at most, and
 * a few elements the parser implies (`html`, `head`, `body`, `tbody`):
 * a written element needs a tag of three characters at least, and an
 * attribute a character, so only formatting the parser opens again in
 * each paragraph (unclosed `<b>`s of different attributes), each time
 * with all its attributes, comes near it, at a cost of the square of the
 * HTML's length.
 */
const maxElements = (html: string): number => html.length + 16;

/**
 * parse5's own tree, but refusing markup past {@link maxDepth} or
 * {@link maxElements}: what keeps the tree it builds, and the memory,
 * linear in the HTML's length. One tag of thousands of attributes still
 * costs parse5's tokenizer their number squared, before any tree sees it:
 * that is left to the connector isolate's CPU limit, which ends the call.
 */
const boundedTree = (
  html: string
): TreeAdapter<DefaultTreeAdapterTypes.DefaultTreeAdapterMap> => {
  /** Each template's content, by the template: it nests at its depth. */
  const templates = new WeakMap<object, Element>();
  let elements = 0;
  /** Counts `count` elements and attributes against {@link maxElements}. */
  const built = (count: number): void => {
    elements += count;
    if (elements > maxElements(html)) {
      throw new ToolError("This text's markup is too complex to read", {
        code: "too_large",
      });
    }
  };
  /**
   * Refuses an element placed in `parent` past {@link maxDepth}, counted
   * where it is now: the tree builder moves whole branches deeper (the
   * adoption agency), so a depth noted when an element was placed can be
   * stale by the time it gets children.
   */
  const placed = (parent: ParentNode, node: Node): void => {
    if (!("tagName" in node)) {
      return;
    }
    let depth = 1;
    for (
      let at: ParentNode | null = templates.get(parent) ?? parent;
      at !== null && "tagName" in at;
      at = templates.get(at.parentNode ?? {}) ?? at.parentNode
    ) {
      depth += 1;
      if (depth > maxDepth) {
        throw new ToolError("This text's markup nests too deep to read", {
          code: "too_large",
        });
      }
    }
  };
  return {
    ...defaultTreeAdapter,
    createElement: (tagName, namespaceURI, attrs) => {
      built(1 + attrs.length);
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    appendChild: (parent, node) => {
      placed(parent, node);
      defaultTreeAdapter.appendChild(parent, node);
    },
    // Before a table, an element the tree builder fosters there: looking
    // up its place costs the parent's children each time.
    insertBefore: (parent, node, before) => {
      built(parent.childNodes.length);
      placed(parent, node);
      defaultTreeAdapter.insertBefore(parent, node, before);
    },
    insertTextBefore: (parent, text, before) => {
      built(parent.childNodes.length);
      defaultTreeAdapter.insertTextBefore(parent, text, before);
    },
    // A `body` or `html` tag again adds its attributes to the element's,
    // looking through all it has.
    adoptAttributes: (recipient, attrs) => {
      built(recipient.attrs.length + attrs.length);
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
    },
    setTemplateContent: (template, content) => {
      templates.set(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
  };
};

/** HTML's whitespace, which a browser shows as one space outside `pre`. */
const whitespace = /[\t\n\f\r ]+/gu;
const noBreakSpace = /\u00A0/gu;
const spacesBeforeBreak = /[ \t]+\n/gu;
const spacesBeforeTab = / +\t/gu;
const blankLines = /\n{2,}/gu;

/** What ends once an element's content is read: a line, a cell, `pre`. */
interface Leaving {
  leave: "line" | "cell" | "inCell" | "pre";
}

/**
 * The text of HTML as Graph gives it (a OneNote page, a Teams message),
 * parsed as a browser parses it (parse5, the HTML standard's own
 * algorithm), so no markup passes for text and no text hides in markup:
 * a line per paragraph, heading, list item and table row, cells apart by
 * a tab, whitespace as a browser shows it (a no-break space as a space),
 * and no blank lines. What a browser never shows is no text of it, nor
 * are images, drawings, ink and attachments. Read in a loop, not by recursion, so
 * markup however deep or wide can't exhaust the stack; markup that would
 * build more than its length is refused (`boundedTree`).
 */
export const htmlText = (html: string): string => {
  const pieces: string[] = [];
  const steps: (Node | Leaving)[] = [];
  const pushChildren = (nodes: readonly Node[]): void => {
    for (let at = nodes.length - 1; at >= 0; at -= 1) {
      const node = nodes[at];
      if (node !== undefined) {
        steps.push(node);
      }
    }
  };
  pushChildren(parse(html, { treeAdapter: boundedTree(html) }).childNodes);
  let pre = 0;
  let cells = 0;
  let rowCells = 0;
  /** Whether nothing but a line break or a tab stands before what comes next. */
  let atBreak = true;
  /** Whether a space does. */
  let spaced = false;
  const push = (text: string): void => {
    if (text !== "") {
      pieces.push(text);
      atBreak = text.endsWith("\n") || text.endsWith("\t");
      spaced = text.endsWith(" ");
    }
  };
  /** A space between words, one however many ask for it, as a browser shows it. */
  const space = (): void => {
    if (!atBreak && !spaced) {
      push(" ");
    }
  };
  const leave = ({ leave: what }: Leaving): void => {
    if (what === "line") {
      push("\n");
    } else if (what === "inCell") {
      space();
    } else if (what === "cell") {
      cells -= 1;
    } else {
      pre -= 1;
    }
  };
  const read = (text: string): void => {
    if (pre > 0) {
      push(text);
      return;
    }
    const collapsed = text
      .replaceAll(noBreakSpace, " ")
      .replaceAll(whitespace, " ");
    push(atBreak || spaced ? collapsed.trimStart() : collapsed);
  };
  const enter = (element: Element): void => {
    const { tagName } = element;
    if (tagName === "br" && cells > 0) {
      space();
    } else if (tagName === "br") {
      push("\n");
    } else if (tagName === "tr") {
      rowCells = 0;
    }
    if (tagName === "td" || tagName === "th") {
      // A row's cells apart by a tab, however their ends are written.
      if (rowCells > 0) {
        push("\t");
      }
      rowCells += 1;
      cells += 1;
      steps.push({ leave: "cell" });
    } else if (lineEnds.has(tagName)) {
      // A block starts a line of its own, as a browser shows it; in a
      // cell, it keeps to the cell's line.
      const inCell = cells > 0 && tagName !== "tr" && tagName !== "table";
      if (inCell) {
        space();
      } else if (!atBreak) {
        push("\n");
      }
      steps.push({ leave: inCell ? "inCell" : "line" });
    }
    if (tagName === "pre") {
      pre += 1;
      steps.push({ leave: "pre" });
    }
    pushChildren(shownChildren(element));
  };
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    if ("leave" in step) {
      leave(step);
    } else if (step.nodeName === "#text" && "value" in step) {
      read(step.value);
    } else if ("tagName" in step && !isUnread(step)) {
      enter(step);
    }
  }
  return pieces
    .join("")
    .replaceAll(spacesBeforeBreak, "\n")
    .replaceAll(spacesBeforeTab, "\t")
    .replaceAll(blankLines, "\n")
    .trim();
};
