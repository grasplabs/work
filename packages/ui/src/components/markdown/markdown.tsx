// Markdown: an agent's answer, drawn from micromark's syntax tree (parse.ts) with the system's parts,
// never as HTML. While it streams, a finished block is read and drawn once, keyed by its place so
// it never fades in again; only the block still being written is read again, made whole first, and
// each new word fades in once it is whole. Written here, a table keeps its even columns and lines
// break where they fill (`greedy`), so nothing drawn moves; fenced code with no place is still
// coming in.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  createElement,
  Fragment,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ComponentProps,
  ComponentType,
  ReactElement,
  ReactNode,
} from "react";

import { useCopy } from "../../hooks/use-copy";
import { useI18n } from "../../lib/i18n";
import type { I18nCatalog } from "../../lib/i18n";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  Icon,
} from "../../lib/icons";
import {
  choiceBoxStyles,
  fadeIn,
  focusRing,
  visuallyHidden,
} from "../../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../../lib/tokens.stylex";
import {
  announce,
  csvOf,
  safeHref,
  saveFile,
  tsvOf,
  useReducedMotion,
} from "../../lib/utils";
import type { LayoutStyle } from "../../lib/utils";
import { iconVars, motionVars } from "../../lib/vars.stylex";
import { Alert, AlertDescription, AlertTitle } from "../alert";
import type { AlertVariant } from "../alert";
import { Button } from "../button";
import * as Code from "../code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Link } from "../link";
import { Separator } from "../separator";
import * as Tables from "../table";
import { tableVars } from "../table.stylex";
import { Diagram } from "./diagram";
import * as parse from "./parse";
import type { Block, RootContent } from "./parse";

/** A link in the answer, as the host's renderer sees it. */
export interface MarkdownLink {
  /** The address exactly as the source has it, any scheme. */
  href: string;
  /** The address's scheme in lower case (`javascript`, `https`); empty for none. */
  scheme: string;
  /** The link's title, when the source gives one: `[words](url "title")`. */
  title?: string;
  /** What the link says, drawn as Markdown draws it; for a picture, its alt words. */
  children: ReactNode;
  /** `link` for `[words](url)` and a reference, `autolink` for a bare address, `image` for a picture. */
  type: "link" | "image" | "autolink";
}

/** Draws a link in Markdown's place, or gives undefined to leave it to Markdown. */
export type MarkdownLinkRenderer = (link: MarkdownLink) => ReactNode;

type Of<T extends RootContent["type"]> = Extract<RootContent, { type: T }>;
type Phrase = Of<"paragraph">["children"][number];
type Row = Of<"table">["children"][number];
/** A node of the syntax tree Markdown draws: a block, a phrase, a list's item, a table's row or cell. */
export type MarkdownNode =
  | Block
  | Phrase
  | Of<"list">["children"][number]
  | Row
  | Row["children"][number];
type Node = MarkdownNode;

/** The elements Markdown draws that a caller may draw instead, by their HTML names. */
type Blocks = "p" | "blockquote" | "ul" | "ol" | "li" | "hr" | "pre" | "code";
type Cells = "table" | "thead" | "tbody" | "tr" | "th" | "td";
type Phrases = "a" | "img" | "strong" | "em" | "del";
type MarkdownElement = `h${1 | 2 | 3 | 4 | 5 | 6}` | Blocks | Cells | Phrases;

/**
 * Elements drawn in Markdown's place, keyed by HTML element name (a map written for react-markdown
 * or Streamdown carries over): each is given the element's own props (its `children`; `href` and
 * `title` for `a`, `src`, `alt` and `title` for `img`, `className` `language-…` for fenced code,
 * `start` for `ol`, `align` for a cell, `dir` `auto` for a paragraph, heading, item, quote or cell)
 * and the syntax tree's `node` it draws, which is internal.
 */
export type MarkdownComponents = {
  [Tag in MarkdownElement]?: ComponentType<
    ComponentProps<Tag> & { node: MarkdownNode }
  >;
};

/** Every prop a Markdown takes. */
export interface MarkdownProps {
  /** The Markdown: the agent's answer, or as much of it as has arrived. */
  children: string;
  /** Still being written: a half-written end is drawn whole, each new word fades in once whole. @default false */
  streaming?: boolean;
  /** Cut off part way: the end is made whole as while streaming, so no raw mark shows. @default false */
  truncated?: boolean;
  /**
   * How a screen reader hears it while it is written: `polite`, each block once it is finished;
   * `off`, nothing, for words beside the answer that another part already says (Reasoning's
   * thoughts, which say only that thinking started).
   * @default "polite"
   */
  live?: "polite" | "off";
  /** `message` in a chat message; `sm` a card or a panel; `xs` a muted note. @default "default" */
  size?: "default" | "message" | "sm" | "xs";
  /** The outline level of a `#` heading, so the page's outline never skips. @default 1 */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * A single newline inside a paragraph is a line break, for answers written as short lines; off,
   * it is a space, as CommonMark has it, so a paragraph wrapped by hand reads as one.
   * @default false
   */
  softBreaks?: boolean;
  /**
   * Fenced code past this many lines is folded under Show more, as CodeBlockContent's `maxLines`.
   * `false` never folds; a block still draws at most its first 2,000 lines (a line says how many
   * more, and Copy takes all), since the text comes from a model and has no bound.
   * @default 18
   */
  codeMaxLines?: number | false;
  /**
   * Draws the answer's links and pictures, any scheme, before Markdown's own filter; undefined
   * leaves one to Markdown (http, https, mailto, tel or a path here as a Link, else its words; a
   * picture is never loaded). Never handed an address that is still being written.
   */
  renderLink?: MarkdownLinkRenderer;
  /**
   * Draws elements in Markdown's place, keyed by HTML element name (`{ code: MyCode, a: MyLink }`);
   * any left out is Markdown's own. `a` is given only an address Markdown would lead to, whole;
   * `img` only an http or https one, whole, and giving it is the choice to load pictures. `code`
   * draws code in a sentence and fenced code (`node.type` is `code`), in CodeBlock's place; `pre`,
   * when given, holds fenced code's `code`. Task boxes, notes, folding sections and alerts stay
   * Markdown's own. `node` is internal: the parser's node, holding the answer as written (its `url` unchecked),
   * to tell what is drawn by; draw from the checked `href` and `src`.
   */
  components?: MarkdownComponents;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}
const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space["4"],
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    color: colors.bodyForeground,
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  message: {
    fontSize: size.messageText,
    lineHeight: size.messageTextLine,
    [tableVars.text]: size.messageText,
    [tableVars.line]: size.messageTextLine,
  },
  sm: { gap: space["3"], fontSize: font.textSm, lineHeight: font.textSmLine },
  xs: {
    gap: space["2"],
    fontSize: size.messageText,
    lineHeight: size.messageTextLine,
    color: colors.mutedForeground,
  },
  paragraph: { margin: 0, textWrap: "pretty" },
  greedy: { textWrap: "wrap" },
  // A word's fade ends with it: a finished one holds no animation the page keeps weighing.
  word: { animationFillMode: "backwards" },
  heading: {
    margin: 0,
    color: colors.foreground,
    fontWeight: font.weightMedium,
    textWrap: "balance",
  },
  major: { fontSize: font.textLg, lineHeight: font.textLgLine },
  minor: { fontSize: font.textBase, lineHeight: font.textBaseLine },
  smallMinor: { fontSize: font.textSm, lineHeight: font.textSmLine },
  xsHeading: { fontSize: size.messageText, lineHeight: size.messageTextLine },
  strong: { fontWeight: font.weightMedium, color: colors.foreground },
  emphasis: { fontStyle: "italic" },
  deleted: {
    textDecorationLine: "line-through",
    color: colors.mutedForeground,
  },
  inlineCode: {
    direction: "ltr",
    unicodeBidi: "isolate",
    paddingInline: space["1"],
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    backgroundColor: colors.codeBg,
    fontFamily: font.mono,
    fontSize: font.textSm,
    color: colors.foreground,
    // In a cell too, where a table keeps whole words: code may break, so its column still fits.
    overflowWrap: "anywhere",
  },
  xsCode: { fontSize: `calc(${size.messageText} * 0.92)` },
  // A formula in a sentence, and one on lines of its own, wider than the column scrolling sideways.
  // One in a sentence is cut at ten lines' height: a matrix of a thousand rows is thousands of
  // pixels tall.
  // Clipped, not a scroll box, and a flex box, whose baseline is its formula's in every engine
  // (WebKit puts a clipped inline-block's at its bottom): it sits on the line as the words do.
  math: {
    display: "inline-flex",
    maxWidth: "100%",
    maxHeight: "10em",
    overflow: "clip",
    verticalAlign: "baseline",
    direction: "ltr",
    unicodeBidi: "isolate",
  },
  // The formula a size up, as KaTeX's own styles set it: a maths font's letters are smaller than
  // the text's at the same size, and at 1.21em its x-height meets the words'.
  mathSize: { fontSize: "1.21em" },
  mathBlock: {
    display: "block",
    direction: "ltr",
    overflowX: "auto",
    overflowY: "hidden",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    margin: 0,
    padding: 0,
  },
  ordered: { listStyleType: "decimal" },
  unordered: { listStyleType: "disc" },
  // An item's room for its marker, on its own start side: an item in Arabic or Hebrew has its
  // marker on the right, whatever the items round it run.
  indent: { marginInlineStart: space["6"] },
  item: {
    paddingInlineStart: space["1"],
    "::marker": { color: colors.mutedForeground },
  },
  itemBody: { display: "flex", flexDirection: "column", gap: space["2"] },
  // A task: Checkbox's box, read only, before the words.
  task: {
    listStyleType: "none",
    marginInlineStart: 0,
    display: "flex",
    alignItems: "flex-start",
    gap: space["2"],
  },
  // Its tick at the icon's own size: a task in an answer is a mark that it is done, softer than a
  // Checkbox someone presses. On the first line.
  box: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    flexShrink: 0,
    width: size.checkboxBox,
    height: size.checkboxBox,
    marginBlock: `calc((1lh - ${size.checkboxBox}) / 2)`,
    marginInlineStart: space["1"],
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    color: colors.primaryForeground,
  },
  // An alert's blocks, a quote's gap apart.
  alertBody: { display: "flex", flexDirection: "column", gap: space["2"] },
  quote: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    margin: 0,
    paddingInlineStart: space["4"],
    borderInlineStartWidth: size.codeBlockBarWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
    color: colors.mutedForeground,
  },
  // The room a link still being written keeps for Link's quarter step before its words and its
  // arrow after them, so neither its words nor what follows moves when the address is whole.
  linkLead: { display: "inline-block", width: `calc(${space["1"]} / 4)` },
  arrowRoom: {
    display: "inline-block",
    width: `calc(${size.linkMarkGap} + ${size.linkMark} + ${space["1"]} / 4)`,
  },
  // Up high within its line, never above it: a reset's `position: relative` and `top` (Tailwind's,
  // base.css) would raise it again, out of the line and, on an answer's first line, out of its box.
  footnoteMark: {
    position: "static",
    fontSize: font.textXs,
    lineHeight: 0,
    verticalAlign: "super",
  },
  footnotes: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    margin: 0,
    padding: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    listStyleType: "decimal",
  },
  tableActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space["2"],
    // Each button's touch target reaches the middle of the gap to the next, and the room under it.
    "--tap-room-inline": `calc(${space["2"]} / 2)`,
    marginBlockEnd: space["2"],
    // and past the last one's end, inside the answer: a target past it would scroll a box round it.
    paddingInlineEnd: `calc((${size.tapTarget} - ${size.controlSm}) / 2)`,
  },
  more: {
    margin: 0,
    marginBlockStart: `calc(-1 * ${space["2"]})`,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
});

// A section that folds inside prose, as a document's toggle: the chevron before the summary,
// pointing along the line while closed and down while open; the body under the summary's first
// letter. A Collapsible with a look of its own and none of a panel's.
const sectionStyles = stylex.create({
  section: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: space["1"],
    alignItems: "start",
  },
  toggle: {
    gridColumn: "1",
    gridRow: "1",
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1lh",
    height: "1lh",
    padding: 0,
    margin: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: colors.accent },
      ":active": colors.accentActive,
    },
    color: colors.mutedForeground,
    font: "inherit",
    cursor: "pointer",
  },
  // The holder turns; the drawing itself mirrors right to left, as a pointing icon does.
  chevron: {
    display: "inline-flex",
    transform: {
      default: null,
      ":is([aria-expanded=true] > *)": {
        default: "rotate(90deg)",
        ":dir(rtl)": "rotate(-90deg)",
      },
    },
    transitionProperty: "transform",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  summary: {
    gridColumn: "2",
    gridRow: "1",
    display: "block",
    minWidth: 0,
    margin: 0,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  under: { gridColumn: "2", gridRow: "2", minWidth: 0 },
  // Room inside the panel, as room on the panel itself would show while it is closed.
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space["4"],
    minWidth: 0,
    paddingBlockStart: space["2"],
  },
});
const Provided = createContext<MarkdownLinkRenderer | null>(null);

/** Draws some of the links of every Markdown inside it (a product's citations, its own scheme). */
export const MarkdownLinkProvider = ({
  renderLink,
  children,
}: {
  /** Draws a link, or gives undefined to leave it to Markdown. */
  renderLink: MarkdownLinkRenderer;
  /** What holds the Markdown. */
  children: ReactNode;
}) => <Provided value={renderLink}>{children}</Provided>;
type Linked = Extract<Phrase, { url: string } | { referenceType: unknown }>;
interface Shared {
  provided: MarkdownLinkRenderer | null;
  renderLink?: MarkdownLinkRenderer;
  components: MarkdownComponents;
  streaming: boolean;
  size: NonNullable<MarkdownProps["size"]>;
  headingLevel: number;
  greedy: boolean;
  softBreaks: boolean;
  codeMaxLines: number | false;
  inLink?: boolean;
  phrase?: boolean;
  quoted?: boolean;
  notes?: boolean;
}
const PHRASE = { phrase: true };
// A quote takes the direction of its words, and its paragraphs, headings and items the quote's: one
// of their own would hide their words from the quote's `dir="auto"`, which skips an element that
// sets its own.
const QUOTED = { quoted: true };
/** A block's direction: its own words', but in a quote the quote's. */
const dirOf = (shared: Shared) => (shared.quoted === true ? undefined : "auto");
type Kids = (nodes: readonly Node[], within?: Partial<Shared>) => ReactNode;
interface Part<T> {
  node: T;
  shared: Shared;
  kids: Kids;
  name?: string;
  children?: ReactNode;
}

// What changes as the answer grows, read only by the nodes that need it: the link definitions; the
// notes; the last word still being written (a bare address in it may still grow); how much of the
// block drawn had been shown before (its words never fade again), and whether the block being
// written has many words (what came since its last read then fades as one); and the place of the
// block drawn (a note leads back to its first mark).
const NO_DEFINITIONS: Of<"definition">[] = [];
const Definitions = createContext(NO_DEFINITIONS);
/** A note marked in the answer: its ids' prefix, its number, whether it has come, its marks' ids. */
interface Marked {
  prefix: string;
  number: number;
  come: boolean;
  marks: readonly string[];
}
const NO_NOTES: ReadonlyMap<string, Marked> = new Map();
const Notes = createContext(NO_NOTES);
const Tail = createContext("");
const Shown = createContext(0);
const Many = createContext(false);
const Writing = createContext(false);
const At = createContext("");
// SAFETY: every node a node of the tree holds is a node of the tree.
const kidsOf = (node: Node) =>
  ("children" in node ? node.children : []) as Node[];
const BLOCKY = /^(?:blockquote|list|listItem|table|tableRow|section)$/u;
const textOf = (node: Node): string =>
  "value" in node
    ? node.value
    : kidsOf(node)
        .map(textOf)
        .join(BLOCKY.test(node.type) ? " " : "");
const linkOf = (
  node: Linked,
  url: string,
  title: unknown,
  children: ReactNode
) => {
  const text = textOf(node);
  const scheme = /^(?<s>[a-z][a-z\d+.-]*):/iu.exec(
    url.replaceAll(/[\s\p{Cc}]/gu, "")
  );
  const link: MarkdownLink = {
    href: url,
    scheme: scheme?.groups?.s?.toLowerCase() ?? "",
    children,
    type: [text, `http://${text}`, `mailto:${text}`].includes(url)
      ? "autolink"
      : "link",
    ...(typeof title === "string" && { title }),
  };
  if (node.type === "image" || node.type === "imageReference") {
    link.type = "image";
  }
  return link;
};

/**
 * The element `tag`: the caller's (`components`), given `props` and the node, else Markdown's own,
 * `own` or the tag itself with `props` and its `looks`.
 */
const part = <T extends MarkdownElement>(
  shared: Shared,
  tag: T,
  node: Node,
  props: ComponentProps<T>,
  looks: readonly (stylex.StyleXStyles | false)[],
  own?: ReactElement
): ReactElement => {
  // SAFETY: `components` maps each tag to a part that takes that tag's props and the node.
  const Custom = shared.components[tag] as
    | ComponentType<ComponentProps<T> & { node: Node }>
    | undefined;
  if (Custom !== undefined) {
    return <Custom {...props} node={node} />;
  }
  return own ?? createElement(tag, { ...props, ...stylex.props(...looks) });
};

/** A link or a picture at an address it may lead to, whole: the caller's `a` or `img`, else Link. */
const leadTo = (
  node: Linked,
  link: MarkdownLink,
  href: string,
  { a: A, img: Img }: MarkdownComponents
) => {
  if (link.type === "image" && Img !== undefined && /^https?:/u.test(href)) {
    const alt = "alt" in node ? (node.alt ?? "") : "";
    return <Img node={node} src={href} alt={alt} title={link.title} />;
  }
  if (link.type !== "image" && A !== undefined) {
    return (
      <A node={node} href={href} title={link.title}>
        {link.children}
      </A>
    );
  }
  return (
    <Link href={href} title={link.title} external={/^https?:/u.test(href)}>
      {link.type === "image" && link.children === "" ? href : link.children}
    </Link>
  );
};

/**
 * A link or a picture whose address can still change: a picture is nothing yet; a link its words,
 * keeping the room its arrow will take while it is Markdown's own and its address so far is
 * nothing, the first letters of a web address, or one.
 */
const held = (
  url: string | undefined,
  shared: Shared,
  tail: string,
  children: ReactNode
): ReactNode => {
  if (url === "streamdown:incomplete-image") {
    return null;
  }
  // The address so far: after the first `](` past the last space or `)`.
  const end = tail.split(/[\s)]/u).at(-1) ?? "";
  const at = end.indexOf("](");
  const so = at === -1 ? "https://" : end.slice(at + 2);
  const own =
    shared.renderLink === undefined &&
    shared.provided === null &&
    shared.components.a === undefined;
  return shared.streaming &&
    shared.inLink !== true &&
    url === "streamdown:incomplete-link" &&
    own &&
    (/^https?:\/\//u.test(so) ||
      ["http://", "https://"].some((web) => web.startsWith(so))) ? (
    <>
      <span aria-hidden="true" {...stylex.props(styles.linkLead)} />
      {children}
      <span aria-hidden="true" {...stylex.props(styles.arrowRoom)} />
    </>
  ) : (
    children
  );
};

/**
 * A link or a picture: the host's, else the caller's `a` or `img`, else Markdown's own Link where
 * the address may lead, else its words. Never while its address can change: a half link or picture,
 * a reference not yet defined, a bare address (its words start where it does) in the word still
 * being written; nor inside a link.
 */
const Anchor = ({
  node,
  shared,
  children,
}: Omit<Part<Linked>, "kids">): ReactNode => {
  const found =
    "url" in node
      ? node
      : use(Definitions).find((each) => each.identifier === node.identifier);
  const [first] = "children" in node ? node.children : [];
  const bare = first?.position?.start.offset === node.position?.start.offset;
  const tail = use(Tail);
  const growing = bare && tail.includes(textOf(node));
  if (
    found === undefined ||
    parse.HALF.has(found.url) ||
    growing ||
    shared.inLink === true
  ) {
    return held(found?.url, shared, tail, children);
  }
  const link = linkOf(node, found.url, found.title, children);
  const drawn = shared.renderLink?.(link);
  const hosted = drawn === undefined ? shared.provided?.(link) : drawn;
  const href = safeHref(parse.encodedHref(found.url), { relative: true });
  return hosted !== undefined || href === null
    ? (hosted ?? children)
    : leadTo(node, link, href, shared.components);
};
/** Where a note's mark is: the place of its block and where it starts in it. */
const markId = (prefix: string, place: string, node: Node) =>
  `${prefix}-ref-${place}-${node.position?.start.offset ?? 0}`;
/** A note in the answer's notes, by its name: number 0 while nothing marks it. */
const useNote = (name: string) =>
  use(Notes).get(name) ?? { prefix: "", number: 0, come: false, marks: [] };
/** A note's mark: its number, leading to the note once the note has come. */
const NoteMark = ({
  node,
  shared,
}: Omit<Part<Of<"footnoteReference">>, "kids">) => {
  const words = useI18n().markdown;
  const { prefix, number, come } = useNote(node.identifier);
  const place = use(At);
  if (number === 0) {
    return `[^${node.label ?? node.identifier}]`;
  }
  const shown = <span aria-label={words.footnote(number)}>{number}</span>;
  return (
    <sup {...stylex.props(styles.footnoteMark)}>
      <span id={markId(prefix, place, node)}>
        {come && shared.inLink !== true ? (
          <Link href={`#${prefix}-fn-${number}`}>{shown}</Link>
        ) : (
          shown
        )}
      </span>
    </sup>
  );
};
/** A list item's or a note's blocks: a paragraph is its words, followed by `after`. */
const body = (nodes: readonly Node[], kids: Kids, after?: ReactElement) => (
  <div {...stylex.props(styles.itemBody)}>
    {nodes.map((child, at) => (
      <Fragment key={at}>
        {child.type === "paragraph" ? (
          <span>
            {kids(child.children, PHRASE)}
            {after !== undefined && " "}
            {after}
          </span>
        ) : (
          kids([child])
        )}
      </Fragment>
    ))}
    {!nodes.some((child) => child.type === "paragraph") && after}
  </div>
);
/** A note at the foot, leading back to each of its marks: `↩`, `↩²`. */
const Note = ({
  node,
  kids,
}: Omit<Part<Of<"footnoteDefinition">>, "shared">) => {
  const words = useI18n().markdown;
  const { prefix, number, marks } = useNote(node.identifier);
  const back = marks.length > 0 && (
    <>
      {marks.map((mark, at) => (
        <Fragment key={mark}>
          {at > 0 && " "}
          <Link href={`#${mark}`} aria-label={words.back(number, at + 1)}>
            ↩{at > 0 && <sup>{at + 1}</sup>}
          </Link>
        </Fragment>
      ))}
    </>
  );
  return (
    <li
      value={number}
      id={`${prefix}-fn-${number}`}
      dir="auto"
      {...stylex.props(styles.indent)}
    >
      {body(node.children, kids, back === false ? undefined : back)}
    </li>
  );
};

/** A task's box: Checkbox's, read only, said by its words beside it. */
const TaskBox = ({ done }: { done: boolean }) => {
  const words = useI18n().markdown;
  return (
    <>
      <span aria-hidden="true" {...stylex.props(styles.box)}>
        <span
          {...stylex.props(
            choiceBoxStyles.face,
            done ? choiceBoxStyles.full : choiceBoxStyles.empty
          )}
        >
          {done && <Icon icon={CheckIcon} />}
        </span>
      </span>
      <span {...stylex.props(visuallyHidden)}>
        {done ? words.done : words.notDone}
      </span>
    </>
  );
};
const BREAK = /^<br\s*\/?>$/iu;
/** A phrase that draws nothing: a tag other than `<br>`, or the white space between such tags. */
const isOnlyTag = (node: Node) =>
  node.type === "html"
    ? !BREAK.test(node.value)
    : node.type === "text" && node.value.trim() === "";
const FOUND = /^(?:definition|footnoteDefinition|footnoteReference)$/u;
/** A block that draws nothing where it stands: a definition, a note, or a paragraph of tags alone. */
const drawsNothing = (node: Node) =>
  FOUND.test(node.type) ||
  (node.type === "paragraph" && node.children.every(isOnlyTag));
type Draw<T extends Node["type"]> = (
  node: Extract<Node, { type: T }>,
  shared: Shared,
  kids: Kids
) => ReactNode;

// A table is named by the heading above it; a row draws its own cells, as many as the head's. One
// from a model has no bound: at most 1,000 rows are drawn, and a line says how many more.
const MOST_ROWS = 1000;
/** A table's cells as Markdown: a pipe or a backslash in a cell kept as written. */
const markdownOf = (rows: readonly (readonly string[])[]) =>
  rows
    .flatMap((cells, at) => {
      const line = `| ${cells.map((cell) => cell.replaceAll(/[\\|]/gu, "\\$&")).join(" | ")} |`;
      return at === 0
        ? [line, `| ${cells.map(() => "---").join(" | ")} |`]
        : [line];
    })
    .join("\n");
/**
 * A table's Copy (as Markdown, CSV or TSV) and Download (as CSV or Markdown), as a chat's tables
 * have them: out of use while the answer is written. Each is written from the rows when it is
 * chosen, not each time the table is drawn.
 */
const TableActions = ({
  rows,
  disabled,
}: {
  rows: readonly (readonly string[])[];
  disabled: boolean;
}) => {
  const words = useI18n().markdown;
  // The format chosen in Copy's menu, read when it copies: CopyButton's copy, said as its is.
  const format = useRef(markdownOf);
  const copy = useCopy(() => format.current(rows));
  const copyAs = (as: typeof markdownOf) => () => {
    format.current = as;
    void copy.run();
  };
  return (
    <div {...stylex.props(styles.tableActions)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={words.copyTable}
            // A copy is over within a frame: it shows where it went, never a spinner.
            status={copy.status === "loading" ? "idle" : copy.status}
          >
            <Icon icon={CopyIcon} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={copyAs(markdownOf)}>
            {words.markdown}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={copyAs(csvOf)}>
            {words.csv}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={copyAs(tsvOf)}>
            {words.tsv}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={words.downloadTable}
          >
            <Icon icon={DownloadIcon} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              saveFile(
                `\uFEFF${csvOf(rows)}`,
                "table.csv",
                "text/csv;charset=utf-8"
              );
            }}
          >
            {words.csv}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              saveFile(markdownOf(rows), "table.md", "text/markdown");
            }}
          >
            {words.markdown}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

const TableBlock = ({ node, shared, kids, name }: Part<Of<"table">>) => {
  const words = useI18n().markdown;
  const [head, ...rows] = node.children;
  const sides = { left: "start", right: "end", center: "center" } as const;
  const align = (head?.children ?? []).map(
    (_, at) => sides[node.align?.[at] ?? "left"]
  );
  const row = (cells: Row | undefined, tag: "th" | "td") => {
    const Cell = tag === "th" ? Tables.TableHead : Tables.TableCell;
    const drawn = cells?.children.slice(0, align.length).map((cell, at) => {
      const children = kids(cell.children, PHRASE);
      const side = align[at] ?? "start";
      const props = {
        align: node.align?.[at] ?? undefined,
        dir: "auto",
        children,
      };
      // Its words wrap as a sentence's do, its name too (as GitHub's), so the table fits its column
      // and scrolls sideways only when they cannot: a column of figures the Markdown sets to the
      // right stays on one line.
      const own = (
        <Cell align={side} dir="auto" wrap={side !== "end"}>
          {children}
        </Cell>
      );
      return (
        <Fragment key={at}>{part(shared, tag, cell, props, [], own)}</Fragment>
      );
    });
    const own = <Tables.TableRow>{drawn}</Tables.TableRow>;
    return cells && part(shared, "tr", cells, { children: drawn }, [], own);
  };
  const top = row(head, "th");
  const lines = rows
    .slice(0, MOST_ROWS)
    .map((cells, at) => <Fragment key={at}>{row(cells, "td")}</Fragment>);
  const label = name ?? words.table;
  const header = <Tables.TableHeader>{top}</Tables.TableHeader>;
  const children = (
    <>
      {part(shared, "thead", node, { children: top }, [], header)}
      {part(
        shared,
        "tbody",
        node,
        { children: lines },
        [],
        <Tables.TableBody>{lines}</Tables.TableBody>
      )}
    </>
  );
  const more =
    Math.max(rows.length - MOST_ROWS, 0) +
    ("more" in node ? Number(node.more) : 0);
  // What Copy and Download take: the cells drawn, as their words.
  const cells = [head, ...rows.slice(0, MOST_ROWS)].flatMap((each) =>
    each === undefined
      ? []
      : [each.children.slice(0, align.length).map((cell) => textOf(cell))]
  );
  const own = (
    <>
      <TableActions rows={cells} disabled={shared.streaming} />
      <Tables.Table aria-label={label} streaming={shared.greedy}>
        {children}
      </Tables.Table>
      {more > 0 && <p {...stylex.props(styles.more)}>{words.moreRows(more)}</p>}
    </>
  );
  return part(
    shared,
    "table",
    node,
    { "aria-label": label, children },
    [],
    own
  );
};
const MARKS = {
  strong: ["strong", styles.strong],
  emphasis: ["em", styles.emphasis],
  delete: ["del", styles.deleted],
} as const;
const mark = (
  node: Extract<Phrase, { type: keyof typeof MARKS }>,
  shared: Shared,
  kids: Kids
) => {
  const [tag, look] = MARKS[node.type];
  return part(shared, tag, node, { children: kids(node.children) }, [look]);
};
const anchor = (node: Linked, shared: Shared, kids: Kids) => (
  <Anchor node={node} shared={shared}>
    {"children" in node
      ? kids(node.children, { inLink: true })
      : (node.alt ?? "")}
  </Anchor>
);
// Scripts written without spaces (Chinese, Japanese, Korean, and their punctuation): each character
// is a word, as Streamdown animates them.
const UNSPACED = String.raw`\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\u3000-\u303F\uFF00-\uFFEF`;
// A word with what follows it.
const WORDS = new RegExp(
  String.raw`[${UNSPACED}]\s*|[^\s${UNSPACED}]+\s*|\s+`,
  "gu"
);
/**
 * Words that may fade in: each its own fade while written, but not in a link (its words move into
 * the link when it is whole, and would fade again there), nor once shown. Past many words in the
 * block still being written, the words read since its last read fade as one, and the rest stand.
 */
const Words = ({
  value,
  shared,
  from,
}: {
  value: string;
  shared: Shared;
  from: number;
}) => {
  const shown = use(Shown) - from;
  const many = use(Many);
  // Drawn plain, never to fade: the parts of it shown before they were first drawn here (`plain`,
  // ranges); past many words, all but what came since the last read (`shown`).
  const [kept, setKept] = useState({
    length: value.length,
    plain: [0, Math.max(shown, 0)],
    shown,
    many,
  });
  let next = kept;
  if (value.length > kept.length) {
    const end = Math.min(Math.max(shown, kept.length), value.length);
    const plain =
      end > kept.length ? [...kept.plain, kept.length, end] : kept.plain;
    next = { ...next, length: value.length, plain };
  }
  if (many && (!kept.many || shown > kept.shown)) {
    next = { ...next, shown, many };
  }
  if (next !== kept) {
    setKept(next);
  }
  if (!shared.streaming || shared.inLink === true) {
    return value;
  }
  if (kept.many) {
    const cut = Math.min(Math.max(kept.shown, 0), value.length);
    return cut === value.length ? (
      value
    ) : (
      <>
        {value.slice(0, cut)}
        <span key={kept.shown} {...stylex.props(fadeIn, styles.word)}>
          {value.slice(cut)}
        </span>
      </>
    );
  }
  // Each word not shown before its own fade, keyed by where it is, so it keeps it as more comes.
  const parts: ReactNode[] = [];
  const fading = (start: number, end: number) => {
    for (const word of value.slice(start, end).matchAll(WORDS)) {
      parts.push(
        <span key={start + word.index} {...stylex.props(fadeIn, styles.word)}>
          {word[0]}
        </span>
      );
    }
  };
  let at = 0;
  for (let range = 0; range < kept.plain.length; range += 2) {
    const [start = 0, end = 0] = kept.plain.slice(range, range + 2);
    fading(at, start);
    parts.push(value.slice(Math.max(start, at), Math.max(end, at)));
    at = Math.max(at, end);
  }
  fading(at, value.length);
  return parts;
};
const framed = new Set(["code", "math", "table", "thematicBreak"]);

/** Draws `tex` into `box` with KaTeX, loaded the first time; false once the formula has gone. */
const drawFormula = async (
  box: HTMLElement,
  { tex, display }: { tex: string; display: boolean },
  live: () => boolean
) => {
  try {
    const { default: katex } = await import("katex");
    if (!live()) {
      return false;
    }
    katex.render(tex, box, {
      displayMode: display,
      output: "mathml",
      throwOnError: false,
      errorColor: colors.mutedForeground,
      trust: false,
      strict: "ignore",
      // No rule, space or box past 10em, and no macro expanded more than 1,000 times.
      maxSize: 10,
      maxExpand: 1000,
    });
    return true;
  } catch {
    // KaTeX did not load: the formula stays its TeX.
    return false;
  }
};
// A formula longer than this stays its TeX: the browser lays out MathML on the page, and 100 KB of
// it takes seconds.
const MOST_TEX = 4000;
/**
 * A formula, in TeX: drawn by KaTeX as MathML, which the browser lays out itself, once KaTeX has
 * loaded (only a page with maths loads it), and its TeX as code until then and without script.
 * KaTeX builds the nodes itself, never HTML from text; with `trust` off, no command in a formula
 * can lead anywhere or add a class or a style, and one it cannot read is its TeX, muted.
 */
const Formula = ({ tex, display }: { tex: string; display: boolean }) => {
  const box = useRef<HTMLSpanElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let live = true;
    const at = box.current;
    const draw = async () => {
      if (
        at !== null &&
        tex.length <= MOST_TEX &&
        (await drawFormula(at, { tex, display }, () => live))
      ) {
        setDrawn(true);
      }
    };
    void draw();
    return () => {
      live = false;
    };
  }, [tex, display]);
  return (
    <span
      data-slot="markdown-math"
      data-tex={tex}
      data-display={display || undefined}
      {...stylex.props(display ? styles.mathBlock : styles.math)}
    >
      <span ref={box} hidden={!drawn} {...stylex.props(styles.mathSize)} />
      {!drawn && <code {...stylex.props(styles.inlineCode)}>{tex}</code>}
    </span>
  );
};
/** A block in the answer's column: a framed one fades in whole while written; a section is its own. */
const Placed = ({
  node,
  shared,
  children,
}: {
  node: Node;
  shared: Shared;
  children: ReactElement;
}) =>
  node.type === "section" ? (
    children
  ) : (
    <div {...stylex.props(shared.streaming && framed.has(node.type) && fadeIn)}>
      {children}
    </div>
  );

/**
 * A section (parse.ts): the chevron before its summary, its blocks under the summary's first letter,
 * closed until it is opened. The toggle is named by the summary's words and says whether it is open.
 */
const SectionBlock = ({ node, shared, kids }: Part<parse.Section>) => {
  const id = useId();
  const place = use(At);
  const shown = use(Shown);
  const [words] = parse.readBlock(node.summary);
  return (
    <Collapsible asChild defaultOpen={node.open}>
      <div
        data-slot="markdown-section"
        {...stylex.props(sectionStyles.section)}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-labelledby={id}
            {...stylex.props(sectionStyles.toggle, focusRing)}
          >
            <span aria-hidden="true" {...stylex.props(sectionStyles.chevron)}>
              <Icon icon={ChevronRightIcon} />
            </span>
          </button>
        </CollapsibleTrigger>
        <div id={id} {...stylex.props(sectionStyles.summary)}>
          <Shown value={shown - node.starts.summary}>
            {words?.type === "paragraph" && kids(words.children, PHRASE)}
          </Shown>
        </div>
        <CollapsibleContent asChild>
          <div {...stylex.props(sectionStyles.under)}>
            <div {...stylex.props(sectionStyles.body)}>
              {node.children.map((child, at) =>
                drawsNothing(child) ? null : (
                  <Placed key={at} node={child} shared={shared}>
                    {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- a string */}
                    <At value={`${place}.${at}`}>
                      <Shown value={shown - (node.starts.children[at] ?? 0)}>
                        {kids([child])}
                      </Shown>
                    </At>
                  </Placed>
                )
              )}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

// GitHub's alerts, each as the Alert of its meaning. A quote is one when its first line is only the
// mark, in any case, and more follows it, as GitHub reads one; any other mark leaves it a quote.
// While written, a quote of the mark alone is already the alert, so the mark never shows.
type AlertKind = keyof I18nCatalog["markdown"]["alerts"];
const ALERTS: Readonly<Record<AlertKind, AlertVariant>> = {
  note: "info",
  tip: "success",
  important: "default",
  warning: "warning",
  caution: "destructive",
};
const ALERT = /^\[!(?<kind>[a-z]+)\][ \t]*(?:\n|$)/iu;
/**
 * A quote's first paragraph, its first words `lead`, less the mark's line `cut` long and a hard
 * break after it. The words kept end where `lead` ends, so they start that far from its end.
 */
const afterMark = (
  first: Of<"paragraph">,
  lead: Of<"text">,
  cut: number
): Node[] => {
  const phrases = first.children.slice(1);
  const words = lead.value.slice(cut);
  const end = lead.position?.end;
  const kept: Phrase[] =
    words === ""
      ? phrases.slice(phrases[0]?.type === "break" ? 1 : 0)
      : [
          {
            type: "text",
            value: words,
            ...(end &&
              lead.position && {
                position: {
                  ...lead.position,
                  start: { ...end, offset: (end.offset ?? 0) - words.length },
                },
              }),
          },
          ...phrases,
        ];
  return kept.length > 0 ? [{ ...first, children: kept }] : [];
};
const isKind = (kind: string): kind is AlertKind => Object.hasOwn(ALERTS, kind);
/**
 * The alert a quote is (its kind and its blocks after the mark), or null for a quote. `writing`: the
 * quote is in the block still being written, where the mark alone is already the alert.
 */
const alertOf = (node: Of<"blockquote">, writing: boolean) => {
  const [first, ...blocks] = node.children;
  const lead = first?.type === "paragraph" ? first.children[0] : undefined;
  const found = lead?.type === "text" ? ALERT.exec(lead.value) : null;
  const kind = found?.groups?.kind?.toLowerCase() ?? "";
  if (
    first?.type !== "paragraph" ||
    lead?.type !== "text" ||
    found === null ||
    !isKind(kind)
  ) {
    return null;
  }
  const said = [...afterMark(first, lead, found[0].length), ...blocks];
  return said.length > 0 || writing ? { kind, blocks: said } : null;
};
/** An alert in the answer: its kind's Alert, titled by its kind, part of the answer (not said again). */
const AlertBlock = ({
  kind,
  children,
}: {
  kind: AlertKind;
  children: ReactNode;
}) => {
  const words = useI18n().markdown.alerts;
  return (
    <Alert variant={ALERTS[kind]} live="off">
      <AlertTitle>{words[kind]}</AlertTitle>
      <AlertDescription>
        <div {...stylex.props(styles.alertBody)}>{children}</div>
      </AlertDescription>
    </Alert>
  );
};

/** A quote, or the alert it is. */
const Quote = ({ node, shared, kids }: Part<Of<"blockquote">>) => {
  const alert = alertOf(node, use(Writing) && shared.streaming);
  return alert === null ? (
    part(
      shared,
      "blockquote",
      node,
      { dir: "auto", children: kids(node.children, QUOTED) },
      [styles.quote]
    )
  ) : (
    <AlertBlock kind={alert.kind}>{kids(alert.blocks)}</AlertBlock>
  );
};

const headings = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
const headingLooks: Partial<
  Record<Shared["size"], readonly stylex.StyleXStyles[]>
> = {
  sm: [styles.minor, styles.smallMinor],
  xs: [styles.xsHeading, styles.xsHeading],
};
const draw: { [T in Node["type"]]?: Draw<T> } = {
  text: (node, shared) => {
    let from = node.position?.start.offset ?? 0;
    const lines = shared.softBreaks ? node.value.split("\n") : [node.value];
    return lines.map((line, at) => {
      from += at > 0 ? (lines[at - 1]?.length ?? 0) + 1 : 0;
      return (
        <Fragment key={at}>
          {at > 0 && <br />}
          <Words value={line} shared={shared} from={from} />
        </Fragment>
      );
    });
  },
  strong: mark,
  emphasis: mark,
  delete: mark,
  inlineCode: (node, shared) =>
    part(shared, "code", node, { children: node.value }, [
      styles.inlineCode,
      shared.size === "xs" && styles.xsCode,
    ]),
  inlineMath: (node) => <Formula tex={node.value} display={false} />,
  math: (node) => <Formula tex={node.value} display />,
  break: () => <br />,
  // A tag is never drawn, and nothing in it becomes an element: `<br>` is a line break, any other
  // tag (and a comment) is dropped, and the words round it stay Markdown.
  html: (node) => (BREAK.test(node.value) ? <br /> : null),
  link: anchor,
  linkReference: anchor,
  image: anchor,
  imageReference: anchor,
  footnoteReference: (node, shared) => <NoteMark node={node} shared={shared} />,
  footnoteDefinition: (node, shared, kids) =>
    shared.notes === true && <Note node={node} kids={kids} />,
  // A paragraph that holds only tags (a tool's tag on a line of its own) draws nothing.
  paragraph: (node, shared, kids) =>
    node.children.every(isOnlyTag)
      ? null
      : part(
          shared,
          "p",
          node,
          { dir: dirOf(shared), children: kids(node.children, PHRASE) },
          [styles.paragraph, shared.greedy && styles.greedy]
        ),
  heading: (node, shared, kids) => {
    // From the caller's level on; the look is a step up for the first two depths.
    const { depth } = node;
    const tag =
      headings[Math.min(shared.headingLevel - 1 + depth, 6) - 1] ?? "h6";
    const looks = headingLooks[shared.size] ?? [styles.major, styles.minor];
    const look = looks[depth <= 2 ? 0 : 1];
    const children = kids(node.children, PHRASE);
    return part(shared, tag, node, { dir: dirOf(shared), children }, [
      styles.heading,
      look,
      shared.greedy && styles.greedy,
    ]);
  },
  list: (node, shared, kids) => {
    const children = kids(node.children);
    const start = node.start ?? undefined;
    return node.ordered === true
      ? part(shared, "ol", node, { start, children }, [
          styles.list,
          styles.ordered,
        ])
      : part(shared, "ul", node, { children }, [styles.list, styles.unordered]);
  },
  listItem: (node, shared, kids) => {
    const task = typeof node.checked === "boolean";
    const children = (
      <>
        {task && <TaskBox done={node.checked === true} />}
        {body(node.children, kids)}
      </>
    );
    return part(shared, "li", node, { dir: dirOf(shared), children }, [
      styles.indent,
      styles.item,
      task && styles.task,
    ]);
  },
  blockquote: (node, shared, kids) => (
    <Quote node={node} shared={shared} kids={kids} />
  ),
  thematicBreak: (node, shared) =>
    part(shared, "hr", node, {}, [], <Separator />),
  code: (node, shared) => {
    const { code: Custom, pre: Pre } = shared.components;
    if (Custom !== undefined || Pre !== undefined) {
      const lang = node.lang ?? "";
      const className = lang === "" ? undefined : `language-${lang}`;
      const code =
        Custom === undefined ? (
          <code className={className}>{node.value}</code>
        ) : (
          <Custom node={node} className={className}>
            {node.value}
          </Custom>
        );
      return Pre === undefined ? code : <Pre node={node}>{code}</Pre>;
    }
    // A diagram once its fence is closed: until then its code, as it is written.
    if (node.lang === "mermaid" && node.position !== undefined) {
      return <Diagram code={node.value} streaming={shared.streaming} />;
    }
    // Numbered from the fence's `startLine=N` (up to 7 digits), or not with `noLineNumbers`.
    const meta = node.meta ?? "";
    const startLine =
      Number(/\bstartLine=(?<at>\d{1,7})(?!\d)/u.exec(meta)?.groups?.at) || 1;
    return (
      <Code.CodeBlock
        language={node.lang ?? "text"}
        streaming={node.position === undefined}
      >
        <Code.CodeBlockHeader>
          <Code.CodeBlockTitle />
          {/* Saved and copied once the answer is written, as a chat's are. */}
          <Code.CodeBlockActions>
            <Code.CodeBlockDownloadButton
              value={node.value}
              disabled={shared.streaming}
            />
            <Code.CodeBlockCopyButton
              value={node.value}
              disabled={shared.streaming}
            />
          </Code.CodeBlockActions>
        </Code.CodeBlockHeader>
        {/* `false` never folds, yet still draws at most 2,000 lines: a model's code has no bound. */}
        <Code.CodeBlockContent
          lineNumbers={!/\bnoLineNumbers\b/u.test(meta)}
          startLine={startLine}
          maxLines={
            shared.codeMaxLines === false
              ? Number.POSITIVE_INFINITY
              : shared.codeMaxLines
          }
        >
          {node.value}
        </Code.CodeBlockContent>
      </Code.CodeBlock>
    );
  },
  section: (node, shared, kids) => (
    <SectionBlock node={node} shared={shared} kids={kids} />
  ),
};
const Drawn = ({ node, shared, name }: Omit<Part<Node>, "kids">): ReactNode => {
  const kids: Kids = (nodes, within) =>
    nodes.map((child, at) => (
      <Drawn
        key={at}
        node={child}
        shared={within ? { ...shared, ...within } : shared}
      />
    ));
  if (node.type === "table") {
    return <TableBlock node={node} shared={shared} kids={kids} name={name} />;
  }
  // SAFETY: each entry of `draw` takes the node of its own type, which `node.type` picks.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const render = draw[node.type] as Draw<Node["type"]> | undefined;
  return render?.(node, shared, kids) ?? null;
};
const useStarts = (source: string) => {
  const [cut, setCut] = useState({ source: "", cut: parse.blockStarts("") });
  if (cut.source === source) {
    return cut.cut.starts;
  }
  const next = parse.blockStarts(
    source,
    source.startsWith(cut.source) ? cut.cut : undefined
  );
  setCut({ source, cut: next });
  return next.starts;
};
const found = new WeakMap<Node, Node[]>();
/** The definitions, notes and notes' marks a block holds, in reading order: found once, by a stack. */
const foundIn = (block: Node) => {
  const known = found.get(block);
  if (known !== undefined) {
    return known;
  }
  const nodes: Node[] = [];
  const stack = [block];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (FOUND.test(node.type)) {
      nodes.push(node);
    }
    for (const kid of kidsOf(node).toReversed()) {
      stack.push(kid);
    }
  }
  found.set(block, nodes);
  return nodes;
};
/** Each block with its place (`3`, and `3.1` for the second block of a section in the fourth). */
const placesOf = (
  blocks: readonly Node[],
  at = ""
): (readonly [string, Node])[] =>
  blocks.flatMap((block, index) => {
    const place = at === "" ? String(index) : `${at}.${index}`;
    return block.type === "section"
      ? placesOf(block.children, place)
      : [[place, block]];
  });
// A line that may start a definition, in a quote or a list item too: a link's, or (`^`) a note's.
const DEFINED =
  /^(?:[ \t>]|[-*+][ \t]|\d{1,9}[.)][ \t])*\[(?<note>\^?)(?<label>(?:[^[\]\\]|\\.){1,999})\]:/gmu;
/** The names of the notes `text` defines. */
const notesIn = (text: string) =>
  [...text.matchAll(DEFINED)].flatMap(({ groups }) =>
    groups?.note === "^"
      ? [(groups.label ?? "").replaceAll(/\s+/gu, " ").trim().toLowerCase()]
      : []
  );
/** What a finished block says: a table its name, a section its summary, an alert its title and words. */
const saidOf = (
  node: Node,
  name: string | undefined,
  words: I18nCatalog["markdown"]
) => {
  if (node.type === "table") {
    return name ?? words.table;
  }
  if (node.type === "section") {
    return node.summary;
  }
  const alert = node.type === "blockquote" ? alertOf(node, false) : null;
  if (alert !== null) {
    const text = alert.blocks.map((block) => textOf(block)).join(" ");
    return `${words.alerts[alert.kind]} ${text}`;
  }
  return FOUND.test(node.type) || node.type === "code" ? "" : textOf(node);
};
/**
 * While written, what each block says once it is finished (saidOf): never each word, nor code
 * (CodeBlock says it is being written). The blocks already finished when it is first drawn while
 * written are said then, once; an answer first drawn whole (opened from history) is not said.
 */
const useSaid = (
  blocks: readonly Node[],
  streaming: boolean,
  live: boolean,
  names: readonly (string | undefined)[]
) => {
  const words = useI18n().markdown;
  const told = useRef<number | null>(null);
  const finished = streaming ? Math.max(blocks.length - 1, 0) : blocks.length;
  useEffect(() => {
    const from = told.current ?? (streaming ? 0 : finished);
    told.current = finished;
    if (!live || finished <= from) {
      return;
    }
    const said = blocks
      .slice(from, finished)
      .map((node, at) => saidOf(node, names[from + at], words).trim())
      .filter((text) => text !== "")
      .join(" ");
    if (said !== "") {
      announce(said);
    }
  }, [blocks, finished, live, names, streaming, words]);
};
// While written, a table's head waits for its row of dashes. A last
// line that is only the start of a block's mark waits for the characters that decide it: a list's
// number or bullet, a task's box, a heading's, rule's or underline's marks, a note's start, a link's
// definition (never drawn) or a bracket that may start one, the start of a section's `<details>` or
// `</details>`. So do a mark of emphasis or code, a `!` or a `<`, at the very end.
const PIPE = /^ {0,3}\|/u;
const DASHES = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\||$)/mu;
const CONTAINERS = /^(?:[ \t>]|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))*/u;
const UNDECIDED =
  /^(?:[-*+]|\d{1,9}[.)]?|(?:[-*+=_][ \t]*)+|#{1,6}|\[[ xX]?\]?|\[\^[^\]\s]*\]?:?|\[(?!\^)(?:[^\]\\]|\\.){0,999}(?:\]:.*|\]?)|<\/?(?:d(?:e(?:t(?:a(?:i(?:ls?)?)?)?)?)?)?)?[ \t]*$/u;
// The start of a tag (an open tag with its attributes so far, a closing tag, a comment) or of an
// autolink, at the very end.
const HALF_TAG =
  /^<(?:\/?|[a-z][^\s<>]*|[a-z][a-z0-9-]*(?:\s+[a-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^'\n]*'?|"[^"\n]*"?)?)?)*\s*\/?|\/[a-z][a-z0-9-]*\s*|!-?|!--(?:(?!-->)[^])*)$/iu;
/** `end` less what waits; each pattern is anchored or found from the end, so none scans back. */
const lessWaiting = (end: string) => {
  const note = end.lastIndexOf("[^");
  let to = note !== -1 && !/[\]\s]/u.test(end.slice(note)) ? note : end.length;
  // In code still open, every character is code.
  if (parse.inOpenFence(end)) {
    return end;
  }
  // A tag still being written waits for its `>`, attributes and all, and is then dropped; an
  // autolink's start waits for its `>` or a space. Text that cannot be either shows as it comes.
  const tag = end.lastIndexOf("<", to - 1);
  to = tag !== -1 && HALF_TAG.test(end.slice(tag, to)) ? tag : to;
  while (to > 0 && "*_~`[!< \t".includes(end.charAt(to - 1))) {
    to -= 1;
  }
  // A bracket's words, once shown, stay words until it is decided: `[words]`, `[words][name` and
  // `[words][name]` are drawn as `[words`, a link still being written; a note's `[^name]` waits.
  const bracket = end.lastIndexOf("[", to - 1);
  const pair = end.slice(bracket, to);
  const first = end.lastIndexOf("[", bracket - 2);
  if (!/^\[[^\]]*\]?$/u.test(pair)) {
    // Not a bracket at the end.
  } else if (/^\[[^\]]*\]$/u.test(end.slice(first, bracket))) {
    to = bracket - 1;
  } else if (pair.endsWith("]")) {
    to = pair.startsWith("[^") ? bracket : to - 1;
  }
  const line = end.lastIndexOf("\n", to - 1) + 1;
  const last = end.slice(line, to);
  const rest = last.replace(CONTAINERS, "");
  const undecided = last.trim() !== "" && (rest === "" || UNDECIDED.test(rest));
  let whole = end.slice(0, undecided ? line : to);
  // A table's head waits for its whole row of dashes, and is never drawn as pipes.
  for (let row = 0; row < 2; row += 1) {
    const head = whole.lastIndexOf("\n", whole.length - 2) + 1;
    const complete = whole.slice(0, whole.lastIndexOf("\n") + 1);
    if (DASHES.test(complete) || !PIPE.test(whole.slice(head))) {
      break;
    }
    whole = whole.slice(0, head);
  }
  return whole;
};
/** The last word of `text`: a bare address in it may still grow. */
const lastWord = (text: string) =>
  text.slice(
    Math.max(...[" ", "\n", "\t"].map((c) => text.lastIndexOf(c))) + 1
  );
const MANY_WORDS = 1000;
/**
 * The block still being written, read again as it grows: at once while that is quick, and once it
 * takes long, when four times its last read has passed since, so reading takes at most a fifth of
 * the time and new words come about every 100 ms however big it is. Past 1,000 words (`many`), its
 * words since the last read fade as one.
 */
const useEnding = (whole: string, paced: boolean, read: () => Block[]) => {
  const [last, setLast] = useState<{
    whole: string;
    nodes: Block[];
    next: number;
    many: boolean;
  }>({ whole: "", nodes: [], next: 0, many: false });
  const goesOn = paced && last.whole !== "" && whole.startsWith(last.whole);
  useLayoutEffect(() => {
    const again = () => {
      const start = performance.now();
      const nodes = read();
      const now = performance.now();
      const many = whole.split(/\s+/u).length > MANY_WORDS;
      setLast({ whole, nodes, next: now + (now - start) * 4, many });
    };
    const stale = goesOn && whole !== last.whole;
    const wait = stale ? last.next - performance.now() : Number.NaN;
    if (wait <= 0) {
      again();
    }
    const timer = wait > 0 ? setTimeout(again, wait) : undefined;
    return () => {
      clearTimeout(timer);
    };
  });
  if (goesOn) {
    return last;
  }
  const now = { whole, nodes: read(), next: 0, many: false };
  if (paced && whole !== last.whole) {
    setLast(now);
  }
  return now;
};

/**
 * The answer's top-level blocks: the finished ones read once, the one still being written made
 * whole (`ending`, how many), and the last word read; with how much of each had been shown before
 * this read (`shown`). Each block is read with the names the answer defines so far, so a reference
 * resolves as CommonMark says once its definition is finished (in a finished block: its address
 * and title can no longer change), and a note's mark once its note's name is whole.
 */
const useBlocks = (
  children: string,
  streaming: boolean,
  truncated: boolean
) => {
  const source = children.replaceAll(/\r\n?/gu, "\n");
  const starts = useStarts(source);
  // This answer's readings of its blocks: once drawn, it keeps those of the text it draws.
  // oxlint-disable-next-line react/hook-use-state -- made once, never replaced
  const [reads] = useState(parse.newReads);
  useLayoutEffect(() => {
    parse.settle(reads);
  });
  const open = streaming || truncated;
  const last = open ? (starts.at(-1) ?? 0) : source.length;
  let end = source.slice(last);
  // Cut off, a link still being written goes.
  const bracket = end.lastIndexOf("[");
  end =
    truncated && bracket > end.lastIndexOf("]") ? end.slice(0, bracket) : end;
  const texts = (open ? starts.slice(0, -1) : starts).map((start, at) => {
    const to = starts[at + 1] ?? source.length;
    return { start, to, text: source.slice(start, to) };
  });
  // The definitions and notes in the finished blocks that may hold one, as last read: no name
  // changes a definition.
  const defined = texts
    .filter(({ text }) => text.search(DEFINED) !== -1)
    .flatMap(({ text }) => placesOf(parse.readDefinitions(text, reads)))
    .flatMap(([, block]) => foundIn(block));
  const links = defined.flatMap((node) =>
    node.type === "definition" ? [node] : []
  );
  const names = {
    links: new Set(links.map((node) => node.identifier)),
    notes: new Set([
      ...defined.flatMap((node) =>
        node.type === "footnoteDefinition" ? [node.identifier] : []
      ),
      ...notesIn(end),
    ]),
  };
  const blocks = texts.map(({ start, to, text }) => ({
    start,
    to,
    nodes: parse.readBlock(text, { names }, reads),
  }));
  const done = blocks.flatMap((block) => block.nodes);
  const code = streaming ? parse.openCode(end) : null;
  const whole = lessWaiting(end);
  const ending = useEnding(whole, streaming && code === null, () =>
    open && code === null
      ? parse.readBlock(whole, { open: true, names }, reads)
      : []
  );
  const nodes = code ?? ending.nodes;
  // Words shown before are never faded again: a block shown whole before is shown (Infinity).
  const reach = last + ending.whole.length;
  const [seen, setSeen] = useState({ reach: 0, before: 0 });
  if (seen.reach !== reach) {
    setSeen({ reach, before: seen.reach });
  }
  const shown = [
    ...blocks.flatMap((block) =>
      block.nodes.map(() =>
        seen.before >= block.to
          ? Number.POSITIVE_INFINITY
          : seen.before - block.start
      )
    ),
    ...nodes.map(() => seen.before - last),
  ];
  return {
    all: [...done, ...nodes],
    ending: nodes.length,
    tail: lastWord(ending.whole),
    many: ending.many,
    shown,
    definitions: links.length > 0 ? links : NO_DEFINITIONS,
  };
};

/**
 * The notes, numbered in the order they are first marked, each with its place and its marks
 * outside the notes.
 */
const notesOf = (all: readonly Node[], prefix: string) => {
  const notes = new Map<string, readonly [string, Of<"footnoteDefinition">]>();
  const marks = new Map<string, string[]>();
  for (const [place, block] of placesOf(all)) {
    for (const node of foundIn(block)) {
      if (node.type === "footnoteDefinition" && !notes.has(node.identifier)) {
        notes.set(node.identifier, [place, node]);
      } else if (node.type === "footnoteReference") {
        const ids = marks.get(node.identifier) ?? [];
        marks.set(node.identifier, ids);
        if (block.type !== "footnoteDefinition") {
          ids.push(markId(prefix, place, node));
        }
      }
    }
  }
  const order = [...marks];
  return {
    listed: order.flatMap(([id]) => {
      const note = notes.get(id);
      return note === undefined ? [] : [note];
    }),
    value:
      order.length === 0
        ? NO_NOTES
        : new Map(
            order.map(([id, ids], at) => [
              id,
              { prefix, number: at + 1, come: notes.has(id), marks: ids },
            ])
          ),
  };
};

/** Each table's name: the words of the heading above it. */
const namesOf = (all: readonly Node[]) => {
  let heading: string | undefined;
  return all.map((node) => {
    heading = node.type === "heading" ? textOf(node) : heading;
    return node.type === "table" ? heading : undefined;
  });
};

// The word at the end, nothing after it yet: no space, and no character of a script without spaces.
const UNFINISHED = new RegExp(String.raw`[^\s${UNSPACED}]*$`, "u");
// The most of one word held back: a longer run (an address, a line of minified code) comes this many
// characters at a time.
const LONGEST_WORD = 32;
// How far back the word at the end is looked for: a longer run shows as it comes.
const LOOK_BACK = 256;
// How long the word at the end waits once nothing more comes: a stall shows it.
const WAIT = 250;
/**
 * Where the text shown ends while it is written: before the word at its end, which shows once what
 * follows it has come, so each word comes whole, fades in once and never types itself out. Found
 * from the end, at most LOOK_BACK characters back, so it costs the same however long the answer.
 */
const wordsEnd = (text: string) => {
  const word = UNFINISHED.exec(text.slice(-LOOK_BACK))?.[0].length ?? 0;
  const cut = text.length - (word < LOOK_BACK ? word % LONGEST_WORD : 0);
  // Never half a character written as two (outside the basic plane: emoji, rare Han).
  return (text.codePointAt(cut - 1) ?? 0) > 0xff_ff ? cut - 1 : cut;
};
/**
 * The text as it is drawn: while written, up to the end of its last whole word (wordsEnd), and all
 * of it once nothing more has come for WAIT; written, or with reduced motion (no word fades), all
 * of it. What has shown stays shown.
 */
const useWholeWords = (text: string, streaming: boolean) => {
  const reduced = useReducedMotion();
  // How much a wait let out; none once the text is replaced by a shorter one.
  const [waited, setWaited] = useState(0);
  if (waited > text.length) {
    setWaited(0);
  }
  const end =
    streaming && !reduced
      ? Math.max(wordsEnd(text), Math.min(waited, text.length))
      : text.length;
  const waiting = end < text.length;
  useEffect(() => {
    const timer = waiting
      ? setTimeout(() => {
          setWaited(text.length);
        }, WAIT)
      : undefined;
    return () => {
      clearTimeout(timer);
    };
  }, [text, waiting]);
  return waiting ? text.slice(0, end) : text;
};

const NO_COMPONENTS: MarkdownComponents = {};
export const Markdown = ({
  children,
  streaming = false,
  truncated = false,
  live = "polite",
  size: look = "default",
  headingLevel = 1,
  softBreaks = false,
  codeMaxLines = 18,
  renderLink,
  components = NO_COMPONENTS,
  style,
}: MarkdownProps) => {
  const provided = use(Provided);
  const [written, setWritten] = useState(streaming);
  if (streaming && !written) {
    setWritten(true);
  }
  // Before anything the answer changes, so a finished block is handed the same as before.
  const shared: Shared = {
    provided,
    renderLink,
    components,
    streaming,
    size: look,
    headingLevel,
    greedy: written,
    softBreaks,
    codeMaxLines,
  };
  const notesShared = { ...shared, notes: true };
  const { all, ending, tail, many, shown, definitions } = useBlocks(
    useWholeWords(children, streaming),
    streaming,
    truncated
  );
  const open = streaming || truncated;
  const prefix = useId();
  const notes = notesOf(all, prefix);
  const names = namesOf(all);
  useSaid(all, streaming, live === "polite", names);
  return (
    <div
      data-slot="markdown"
      aria-busy={streaming || undefined}
      {...stylex.props(styles.root, look !== "default" && styles[look], style)}
    >
      <Definitions value={definitions}>
        <Notes value={notes.value}>
          {all.map((node, at) => {
            const writing = open && at >= all.length - ending;
            return drawsNothing(node) ? null : (
              <Placed key={at} node={node} shared={shared}>
                {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- a string */}
                <At value={String(at)}>
                  <Tail value={writing ? tail : ""}>
                    <Shown value={shown[at] ?? 0}>
                      <Many value={writing && many}>
                        <Writing value={writing}>
                          <Drawn node={node} shared={shared} name={names[at]} />
                        </Writing>
                      </Many>
                    </Shown>
                  </Tail>
                </At>
              </Placed>
            );
          })}
          {notes.listed.length > 0 && (
            <Tail value={open ? tail : ""}>
              <ol {...stylex.props(styles.footnotes)}>
                {notes.listed.map(([place, note]) => (
                  <At key={note.identifier} value={place}>
                    <Shown value={shown[Number(place.split(".")[0])] ?? 0}>
                      <Drawn node={note} shared={notesShared} />
                    </Shown>
                  </At>
                ))}
              </ol>
            </Tail>
          )}
        </Notes>
      </Definitions>
    </div>
  );
};
