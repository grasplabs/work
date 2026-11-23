// Markdown: an agent's answer, drawn from Markdown. Headings, paragraphs, lists and tasks, tables
// (Table), quotes, rules (Separator), links (Link), code in a sentence, fenced code (CodeBlock) and
// footnotes. From a syntax tree (parse.ts), never as HTML: raw HTML in the source shows as the text
// it is, and a link of Markdown's own leads only to http, https or mailto.
//
//   <Markdown>{answer}</Markdown>
//   <Markdown streaming>{partial}</Markdown>
//   <Markdown renderLink={(link) => …}>{answer}</Markdown>     the host draws the links
//
// While it streams, what is half-written is made whole (parse.ts, repair): bold is bold from its
// first letter, a table is a table from its first row, an open fence is code still being written,
// and a link still being written keeps the room its arrow will take. Nothing flickers or re-flows
// when a mark closes. The words come as they are given: pacing them is the message's job.
//
// It knows no router and no citation: the host draws any link it wants to (`renderLink`, or a part
// around it through MarkdownLinkProvider). Every value is a token. A caller sets layout only.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createContext,
  Fragment,
  use,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { FC, ReactNode } from "react";

import { useI18n } from "../../lib/i18n";
import { CheckIcon, ChevronRightIcon, Icon } from "../../lib/icons";
import { choiceBoxStyles, focusRing, visuallyHidden } from "../../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../../lib/tokens.stylex";
import { announce, safeHref } from "../../lib/utils";
import type { LayoutStyle } from "../../lib/utils";
import { iconVars, motionVars } from "../../lib/vars.stylex";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "../code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../collapsible";
import { Link } from "../link";
import { Separator } from "../separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../table";
import { tableVars } from "../table.stylex";
import {
  bounded,
  groupSections,
  NOTHING,
  openFence,
  parseMarkdown,
  readBlocks,
  repair,
  schemeOf,
  sectionSaid,
  tidy,
} from "./parse";
import type {
  FootnoteDefinition,
  Grouped,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Placed,
  RootContent,
  TableNode,
} from "./parse";

/** A link in the answer, as the host's renderer sees it. */
export interface MarkdownLink {
  /** The address exactly as the source has it (never resolved against the page), any scheme. */
  href: string;
  /** The address's scheme as a browser reads it, in lower case (`javascript`, `https`); empty for none. */
  scheme: string;
  /** The link's title, when the source gives one: `[words](url "title")`. */
  title?: string;
  /** What the link says: its words, drawn as Markdown draws them; for a picture, its alt words. */
  children: ReactNode;
  /** `link` for `[words](url)` and a reference, `autolink` for a bare address, `image` for a picture. */
  type: "link" | "image" | "autolink";
}

/** Draws a link in Markdown's place, or gives undefined to leave it to Markdown. */
export type MarkdownLinkRenderer = (link: MarkdownLink) => ReactNode;

/** How a single newline inside a paragraph is drawn: a space, a line break, or a break only in a paragraph of short lines. */
export type MarkdownSoftBreaks = "space" | "line" | "auto";

/** Every prop a Markdown takes. */
export interface MarkdownProps {
  /** The Markdown: the agent's answer, or as much of it as has arrived. */
  children: string;
  /**
   * The answer is still being written: what is half-written at its end is shown whole, and once it
   * turns false the end is tidied (as `truncated`).
   * @default false
   */
  streaming?: boolean;
  /**
   * The answer was cut off part way (stopped): a link still being written at its end goes, and
   * bold or code left open is closed, so no raw mark shows. An answer streamed here gets it by
   * itself when `streaming` turns false; set it for a cut answer drawn from history.
   * @default false
   */
  truncated?: boolean;
  /**
   * How a screen reader hears it while it is written: `polite`, each block once it is finished;
   * `off`, nothing, for words beside the answer that another part already says (Reasoning's
   * thoughts, which say only that thinking started).
   * @default "polite"
   */
  live?: "polite" | "off";
  /**
   * `default` for an answer on its own; `message` for an answer inside a chat message, at the
   * message's words (14px on a 22px line), its tables too, its headings and gaps as `default`;
   * `sm` for words in a card or a panel (an agent's instructions, a note), a step smaller, its
   * headings too; `xs` a note beside the answer (an agent's thoughts), at the message's size in
   * the muted ink.
   * @default "default"
   */
  size?: "default" | "message" | "sm" | "xs";
  /**
   * The outline level a `#` heading takes; `##` is one deeper, and so on, down to `h6`. Give the
   * level under the heading the answer stands beneath, so the page's outline never skips.
   * @default 1
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * How a single newline inside a paragraph is drawn. `space`: as CommonMark has it, a space, so a
   * paragraph wrapped by hand reads as one. `line`: a line break, for answers written as short
   * lines. `auto`: a line break only in a paragraph of short lines (two or more, each under 60
   * characters or each "Label: value"); any other paragraph runs on. While it is written, a short
   * line breaks as its newline comes, and nothing drawn apart is drawn back together.
   * @default "space"
   */
  softBreaks?: MarkdownSoftBreaks;
  /**
   * Fenced code past this many lines is folded under Show more, as CodeBlockContent's `maxLines`.
   * @default 18
   */
  codeMaxLines?: number | false;
  /**
   * The host draws the answer's links: called for every link and picture in the text, whatever its
   * scheme, before Markdown's own filter, and what it returns is drawn in its place (a router's
   * link through `<Link asChild>`, a button that asks before leaving, a citation). Return undefined
   * for Markdown's own: http, https and mailto as a Link, anything else as its words; a picture is
   * never loaded unless the host draws it. Footnote marks and their way back stay Markdown's own.
   * While an answer streams, its last link's address can still grow: it is called again as it does.
   */
  renderLink?: MarkdownLinkRenderer;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

const REDUCED = media.reducedMotion;
const HOVER = media.hover;
const arrive = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

// The interface's own type, from the tokens only: body in text-base; headings a step or two up in
// ink, never a page's sizes, as an answer sits inside a message; lists, quotes and rules spaced as
// one column of reading.
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
    // Its own white space, whatever the box round it sets.
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  // Inside a chat message: the message's words in its ink, as a message's plain words are, its
  // tables at the same size; headings and gaps as the default's.
  message: {
    color: colors.foreground,
    fontSize: size.messageText,
    lineHeight: size.messageTextLine,
    [tableVars.text]: size.messageText,
    [tableVars.line]: size.messageTextLine,
  },
  // The smaller size, for words in a card or a panel: a step down, headings too.
  small: {
    gap: space["3"],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // A note beside an answer (`size="xs"`), as an agent's thoughts: the message's size, set apart by
  // the muted ink.
  xsmall: {
    gap: space["2"],
    fontSize: size.messageText,
    lineHeight: size.messageTextLine,
    color: colors.mutedForeground,
  },
  // A block with a frame of its own that arrives while the answer is written fades in; at once with
  // reduced motion.
  arrives: {
    animationName: { default: arrive, [REDUCED]: "none" },
    animationDuration: duration.ui,
    animationTimingFunction: duration.ease,
  },
  paragraph: {
    margin: 0,
    textWrap: "pretty",
  },
  // Written here, word by word: lines break where they fill, never weighed again as a word comes
  // (pretty and balanced wrapping move earlier words to a new line as the last line grows).
  greedy: {
    textWrap: "wrap",
  },
  heading: {
    margin: 0,
    color: colors.foreground,
    fontWeight: font.weightMedium,
    textWrap: "balance",
  },
  major: { fontSize: font.textLg, lineHeight: font.textLgLine },
  minor: { fontSize: font.textBase, lineHeight: font.textBaseLine },
  smallMajor: { fontSize: font.textBase, lineHeight: font.textBaseLine },
  smallMinor: { fontSize: font.textSm, lineHeight: font.textSmLine },
  xsmallHeading: {
    fontSize: size.messageText,
    lineHeight: size.messageTextLine,
  },
  strong: { fontWeight: font.weightMedium, color: colors.foreground },
  emphasis: { fontStyle: "italic" },
  deleted: {
    textDecorationLine: "line-through",
    color: colors.mutedForeground,
  },
  // Code in a sentence: the docs' own chip.
  // Left to right in any language, set apart from the sentence's own direction.
  inlineCode: {
    direction: "ltr",
    unicodeBidi: "isolate",
    paddingInline: space["1"],
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    backgroundColor: colors.codeBg,
    fontFamily: font.mono,
    fontSize: font.textSm,
    color: colors.foreground,
  },
  // At the smallest size, a step under the words, as at the other sizes.
  xsmallCode: { fontSize: `calc(${size.messageText} * 0.92)` },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    margin: 0,
    paddingInlineStart: space["6"],
  },
  ordered: { listStyleType: "decimal" },
  unordered: { listStyleType: "disc" },
  item: {
    paddingInlineStart: space["1"],
    "::marker": { color: colors.mutedForeground },
  },
  // A loose item's paragraphs stand apart, as blocks do.
  itemBody: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
  },
  // A task: Checkbox's box, read only, before the words.
  task: {
    listStyleType: "none",
    marginInlineStart: `calc(-1 * ${space["6"]})`,
    display: "flex",
    alignItems: "flex-start",
    gap: space["2"],
  },
  // Round at the corner, not the system's squircle, and its tick at the icon's own size: a task
  // in an answer is a mark that it is done, softer than a Checkbox someone presses.
  box: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    flexShrink: 0,
    width: size.checkboxBox,
    height: size.checkboxBox,
    // On the first line of the words, whatever their size.
    marginBlock: `calc((1lh - ${size.checkboxBox}) / 2)`,
    marginInlineStart: space["1"],
    borderRadius: radius.mark,
    cornerShape: "round",
    color: colors.primaryForeground,
  },
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
  // The room a link still being written keeps for what the whole one will have: Link's quarter
  // step before its words (its ring's room), and after them the arrow, its gap and the quarter step
  // after. So neither its words nor what follows moves when the address is whole.
  linkLead: {
    display: "inline-block",
    width: `calc(${space["1"]} / 4)`,
  },
  arrowRoom: {
    display: "inline-block",
    width: `calc(${size.linkMarkGap} + ${size.linkMark} + ${space["1"]} / 4)`,
  },
  // A footnote's mark in the sentence, and the notes at the foot.
  footnoteMark: {
    fontSize: font.textXs,
    verticalAlign: "super",
  },
  footnotes: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    margin: 0,
    paddingInlineStart: space["6"],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    listStyleType: "decimal",
  },
  // Raw HTML in the source, shown as the text it is.
  raw: {
    direction: "ltr",
    unicodeBidi: "isolate",
    fontFamily: font.mono,
    fontSize: font.textSm,
    color: colors.mutedForeground,
    whiteSpace: "pre-wrap",
  },
});

// A section that folds inside prose, as a document's toggle: a Collapsible drawn as the section,
// with a look of its own and none of a panel's. The chevron before the summary, pointing along the
// line while closed and turned down while open; the summary at the body's size in the medium
// weight; the body indented to the summary's first letter.
const sectionStyles = stylex.create({
  // Toggle and summary on the first row, the body under the summary on the second.
  section: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: space["1"],
    alignItems: "start",
  },
  // The toggle: a square of the summary's line, the chevron in its middle.
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
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
      ":active": colors.accentActive,
    },
    color: colors.mutedForeground,
    font: "inherit",
    cursor: "pointer",
  },
  // The chevron's holder turns (the drawing itself mirrors right to left, as a pointing icon does).
  chevron: {
    display: "inline-flex",
    // Open, it points down: a quarter turn from along the line, either way round.
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
  // Under the summary, from its first letter: the Collapsible's panel, drawn as this.
  under: {
    gridColumn: "2",
    gridRow: "2",
    minWidth: 0,
  },
  // The answer's own column of blocks, a step under the summary. Inside the panel: room on the
  // panel itself would show while it is closed.
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space["4"],
    minWidth: 0,
    paddingBlockStart: space["2"],
  },
});

/** The links a part around Markdown draws (a citation's chip): asked after the page's own `renderLink`. */
const ProvidedLinks = createContext<MarkdownLinkRenderer | null>(null);

/**
 * Draws some of the links of every Markdown inside it, so no page writes a `renderLink` for them: a
 * product's citations, its own scheme. A Markdown asks its own `renderLink` first, then this; a link
 * neither draws is Markdown's own. While an answer streams, a link inside it is held back until its
 * address has arrived, so a citation never shows first as words.
 */
export const MarkdownLinkProvider = ({
  renderLink,
  children,
}: {
  /** Draws a link, or gives undefined to leave it to Markdown. */
  renderLink: MarkdownLinkRenderer;
  /** What holds the Markdown. */
  children: ReactNode;
}) => <ProvidedLinks value={renderLink}>{children}</ProvidedLinks>;

type Size = NonNullable<MarkdownProps["size"]>;

interface Context {
  /** Each link definition's target and title, by its identifier. */
  definitions: Map<string, { url: string; title: string | undefined }>;
  /** The page's own drawing of a link, when it has one. */
  renderLink: MarkdownLinkRenderer | undefined;
  /** The links a part around Markdown draws (MarkdownLinkProvider). */
  provided: MarkdownLinkRenderer | null;
  /** While written: how much of the source is the stream's own (repair closed the rest). */
  kept: number;
  /** Where the block being drawn starts in the source: its nodes' places count from there. */
  base: number;
  footnotes: Map<string, number>;
  prefix: string;
  /** Still being written. */
  streaming: boolean;
  codeMaxLines: number | false;
  /** The block still being written, at the end of an answer that is. */
  writing: RootContent | undefined;
  /** The fence still being written, at the end of an answer that is: the one CodeBlock that streams. */
  openCode: RootContent | undefined;
  /** Inside a link: a picture or a note's mark there is words, never a link in a link. */
  inLink: boolean;
  words: ReturnType<typeof useI18n>["markdown"];
  /** How a single newline is drawn (`softBreaks`). */
  softBreaks: MarkdownSoftBreaks;
  /** This paragraph draws its single newlines as line breaks. */
  lineBreaks: boolean;
  size: Size;
  /** The outline level of a `#` heading. */
  headingLevel: number;
  /** Written here: its lines break where they fill (styles.greedy). */
  greedy: boolean;
  /** Each reference to a note, and which of the note's references it is, for its own id. */
  references: Map<RootContent, number>;
  /** Each table's name: the words of the heading above it. */
  tableNames: Map<RootContent, string>;
  /** The parts that draw a phrase and a block, handed down so the parts above can draw them. */
  Inline: FC<{ node: PhrasingContent; context: Context }>;
  Block: FC<{ node: RootContent; context: Context }>;
}

type Linked = Extract<PhrasingContent, { type: "link" | "linkReference" }>;
type Pictured = Extract<PhrasingContent, { type: "image" | "imageReference" }>;
type NoteReference = Extract<PhrasingContent, { type: "footnoteReference" }>;
type HeadingNode = Extract<RootContent, { type: "heading" }>;

/** A node of the tree, as far as walking it goes. */
interface Walked {
  type: string;
  value?: string;
  children?: readonly Walked[];
}

/**
 * A block's words as they are said: its phrases run together, its parts (a list's items) apart.
 * Walked with a stack of its own, not by recursion, so no depth of nesting can exhaust the stack.
 */
const spokenOf = (node: Walked): string => {
  const stack: { node: Walked; parts: string[]; next: number }[] = [
    { node, parts: [], next: 0 },
  ];
  let said = "";
  while (stack.length > 0) {
    const top = stack.at(-1);
    if (top === undefined) {
      break;
    }
    const child = top.node.children?.[top.next];
    if (child === undefined) {
      stack.pop();
      const { type, value, children } = top.node;
      const runTogether =
        type === "paragraph" || type === "heading" || type === "tableCell";
      const words =
        children === undefined
          ? (value ?? "")
          : top.parts.join(runTogether ? "" : " ");
      const parent = stack.at(-1);
      if (parent === undefined) {
        said = words;
      } else {
        parent.parts.push(words);
      }
    } else {
      top.next += 1;
      stack.push({ node: child, parts: [], next: 0 });
    }
  }
  return said;
};

/** Every node under `roots`, in reading order, and whether it stands inside a link; by a stack, not recursion. */
const eachNode = (
  roots: readonly RootContent[],
  visit: (node: RootContent, inLink: boolean) => void
) => {
  const stack: { node: RootContent; inLink: boolean }[] = roots
    .toReversed()
    .map((node) => ({ node, inLink: false }));
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) {
      break;
    }
    const { node, inLink } = top;
    visit(node, inLink);
    if ("children" in node) {
      const within =
        inLink || node.type === "link" || node.type === "linkReference";
      for (const child of node.children.toReversed()) {
        stack.push({ node: child, inLink: within });
      }
    }
  }
};

/** A table column's side, from the source's colons. */
const sides = { left: "start", right: "end", center: "center" } as const;

/** A text's single newlines as line breaks, its words between them as they are. */
const withBreaks = (value: string): ReactNode => {
  if (!value.includes("\n")) {
    return value;
  }
  return value.split("\n").map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {line}
    </Fragment>
  ));
};

const SHORT_LINE = 60;
// A labelled line: a few words, a colon, then its value ("Owner: Dana", "Due date: Friday").
const LABELLED = /^[^\s:][^:]{0,30}:\s+\S/u;
// The start of a labelled line still being written: a few words with no colon yet, or the colon.
const LABEL_COMING = /^[^\s:][^:]{0,30}(?::\s*)?$/u;

/**
 * Whether a paragraph's lines are short lines, not prose wrapped by hand (`softBreaks="auto"`): two
 * or more lines, every one under 60 characters or every one "Label: value". While the answer is
 * written, its last line still coming counts if it still may: so a paragraph breaks from its first
 * newline and never runs together again, and prose, whose first line passes 60 before its newline,
 * never breaks at all.
 */
const shortLines = (text: string, writing: boolean) => {
  const lines = text.split("\n").map((line) => line.trim());
  if (lines.length < 2) {
    return false;
  }
  const done = writing ? lines.slice(0, -1) : lines;
  const coming = writing ? (lines.at(-1) ?? "") : "";
  const short =
    done.every((line) => line.length < SHORT_LINE) &&
    coming.length < SHORT_LINE;
  const labelled =
    done.every((line) => LABELLED.test(line)) &&
    (!writing || LABELLED.test(coming) || LABEL_COMING.test(coming));
  return short || labelled;
};

/** The context for one paragraph: whether its single newlines are line breaks. */
const inParagraph = (node: Paragraph, context: Context): Context => {
  const lineBreaks =
    context.softBreaks === "line" ||
    (context.softBreaks === "auto" &&
      shortLines(
        spokenOf(node),
        context.streaming && context.writing === node
      ));
  return lineBreaks === context.lineBreaks
    ? context
    : { ...context, lineBreaks };
};

const Phrasing = ({
  nodes,
  context,
}: {
  nodes: PhrasingContent[];
  context: Context;
}) =>
  nodes.map((node, index) => (
    <context.Inline key={index} node={node} context={context} />
  ));

/** The first letters of a web address, or a `#` repair put in: no address of the link's own yet. */
const isPlaceholder = (url: string | undefined) =>
  url === undefined ||
  url === "#" ||
  "https://".startsWith(url) ||
  "http://".startsWith(url);

/**
 * Whether a link still being written will get an arrow, as far as its address tells yet: none so
 * far, or a web address. One that starts any other way (mailto:) gets none, so no room is kept.
 */
const isComing = (url: string | undefined) =>
  isPlaceholder(url) || /^https?:\/\//u.test(url ?? "");

/** A link node's address and title, from itself or the definition it refers to. */
const targetOf = (
  node: Linked | Pictured,
  context: Context
): { url: string | undefined; title: string | undefined } => {
  if (node.type === "link" || node.type === "image") {
    return { url: node.url, title: node.title ?? undefined };
  }
  const found = context.definitions.get(node.identifier);
  return { url: found?.url, title: found?.title };
};

/** A bare address the text linked by itself (`<https://…>`, `www.…`, `name@host`). */
const isAutolink = (node: Linked) => {
  if (node.type !== "link" || node.children.length !== 1) {
    return false;
  }
  const [only] = node.children;
  return (
    only?.type === "text" &&
    [only.value, `http://${only.value}`, `mailto:${only.value}`].includes(
      node.url
    )
  );
};

/** What the host draws for a link: the page's own first, then the part around Markdown. */
const hosted = (
  context: Context,
  link: Omit<MarkdownLink, "scheme" | "title"> & { title: string | undefined }
): ReactNode => {
  if (context.inLink) {
    return undefined;
  }
  const { title, ...rest } = link;
  const asked: MarkdownLink = {
    ...rest,
    scheme: schemeOf(link.href),
    ...(title === undefined ? {} : { title }),
  };
  const drawn = context.renderLink?.(asked);
  return drawn === undefined ? context.provided?.(asked) : drawn;
};

const LinkInline = ({
  node,
  context,
}: {
  node: Linked;
  context: Context;
}): ReactNode => {
  // Still being written: its end was closed by repair, so its address may still grow.
  const coming =
    context.streaming &&
    context.base + (node.position?.end.offset ?? 0) > context.kept;
  // Where a part around Markdown draws links (MarkdownLinkProvider), such a link is held back,
  // words and all, until its address has arrived: a citation's number never shows as words first,
  // then turns into its mark.
  if (coming && context.provided !== null) {
    return null;
  }
  const { url, title } = targetOf(node, context);
  const words = (
    <Phrasing nodes={node.children} context={{ ...context, inLink: true }} />
  );
  if (url !== undefined && !(context.streaming && isPlaceholder(url))) {
    const drawn = hosted(context, {
      href: url,
      title,
      children: words,
      type: isAutolink(node) ? "autolink" : "link",
    });
    if (drawn !== undefined) {
      return drawn;
    }
  }
  // Markdown's own link waits for its whole address: half of one (`https://exa`) would lead to
  // another site. Until then, its words, with the room its arrow will take, so the words after it
  // never move when the address is whole.
  const href = coming ? null : safeHref(url);
  if (href === null || context.inLink) {
    return context.streaming && !context.inLink && isComing(url) ? (
      <>
        <span aria-hidden="true" {...stylex.props(styles.linkLead)} />
        {words}
        <span aria-hidden="true" {...stylex.props(styles.arrowRoom)} />
      </>
    ) : (
      words
    );
  }
  return (
    <Link href={href} external={!href.startsWith("mailto:")}>
      {words}
    </Link>
  );
};

// A picture is never loaded (no request leaves for it): the host draws it (`renderLink`, type
// `image`), or it is shown by its words and leads to the picture when it may.
const PictureInline = ({
  node,
  context,
}: {
  node: Pictured;
  context: Context;
}): ReactNode => {
  const { url, title } = targetOf(node, context);
  const alt = node.alt ?? "";
  if (url !== undefined && url !== "") {
    const drawn = hosted(context, {
      href: url,
      title,
      children: alt,
      type: "image",
    });
    if (drawn !== undefined) {
      return drawn;
    }
  }
  const href = safeHref(url);
  const words = alt === "" ? (href ?? "") : alt;
  if (href === null || context.inLink) {
    return words;
  }
  return (
    <Link href={href} external>
      {words}
    </Link>
  );
};

const NoteMark = ({
  node,
  context,
}: {
  node: NoteReference;
  context: Context;
}) => {
  const number = context.footnotes.get(node.identifier);
  if (number === undefined) {
    return `[^${node.label ?? node.identifier}]`;
  }
  if (context.inLink) {
    return String(number);
  }
  // Each reference has its own id; the note leads back to the first.
  const nth = context.references.get(node);
  return (
    <sup {...stylex.props(styles.footnoteMark)}>
      <span
        id={
          nth === undefined
            ? undefined
            : `${context.prefix}-ref-${number}-${nth}`
        }
      >
        <Link href={`#${context.prefix}-fn-${number}`}>
          <span aria-label={context.words.footnote(number)}>
            {String(number)}
          </span>
        </Link>
      </span>
    </sup>
  );
};

const Inline = ({
  node,
  context,
}: {
  node: PhrasingContent;
  context: Context;
}): ReactNode => {
  switch (node.type) {
    case "text": {
      return context.lineBreaks ? withBreaks(node.value) : node.value;
    }
    case "strong": {
      return (
        <strong {...stylex.props(styles.strong)}>
          <Phrasing nodes={node.children} context={context} />
        </strong>
      );
    }
    case "emphasis": {
      return (
        <em {...stylex.props(styles.emphasis)}>
          <Phrasing nodes={node.children} context={context} />
        </em>
      );
    }
    case "delete": {
      return (
        <del {...stylex.props(styles.deleted)}>
          <Phrasing nodes={node.children} context={context} />
        </del>
      );
    }
    case "inlineCode": {
      return (
        <code
          {...stylex.props(
            styles.inlineCode,
            context.size === "xs" && styles.xsmallCode
          )}
        >
          {node.value}
        </code>
      );
    }
    case "break": {
      return <br />;
    }
    case "link":
    case "linkReference": {
      return <LinkInline node={node} context={context} />;
    }
    case "image":
    case "imageReference": {
      return <PictureInline node={node} context={context} />;
    }
    case "footnoteReference": {
      return <NoteMark node={node} context={context} />;
    }
    case "html": {
      return <span {...stylex.props(styles.raw)}>{node.value}</span>;
    }
    default: {
      return null;
    }
  }
};

/** A task's box: Checkbox's, read only, said by its words beside it. */
const TaskBox = ({ done, said }: { done: boolean; said: string }) => (
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
    <span {...stylex.props(visuallyHidden)}>{said}</span>
  </>
);

const Item = ({ item, context }: { item: ListItem; context: Context }) => {
  const body = (
    <div {...stylex.props(styles.itemBody)}>
      {item.children.map((child, index) =>
        // A tight item's paragraph is its words, not a block of its own.
        child.type === "paragraph" ? (
          <span key={index}>
            <Phrasing
              nodes={child.children}
              context={inParagraph(child, context)}
            />
          </span>
        ) : (
          <context.Block key={index} node={child} context={context} />
        )
      )}
    </div>
  );
  if (item.checked === null || item.checked === undefined) {
    return <li {...stylex.props(styles.item)}>{body}</li>;
  }
  return (
    <li {...stylex.props(styles.item, styles.task)}>
      <TaskBox
        done={item.checked}
        said={item.checked ? context.words.done : context.words.notDone}
      />
      {body}
    </li>
  );
};

const ListBlock = ({ node, context }: { node: List; context: Context }) => {
  const items = node.children.map((item, index) => (
    <Item key={index} item={item} context={context} />
  ));
  return node.ordered === true ? (
    <ol
      start={node.start ?? undefined}
      {...stylex.props(styles.list, styles.ordered)}
    >
      {items}
    </ol>
  ) : (
    <ul {...stylex.props(styles.list, styles.unordered)}>{items}</ul>
  );
};

// A table scrolls sideways inside its own box, with no bar (Table's), so a wide one never widens the
// answer. A row arrives whole, when its line has ended (repair), so its cells come in together.
const TableBlock = ({
  node,
  context,
}: {
  node: TableNode;
  context: Context;
}) => {
  const [head, ...rows] = node.children;
  // A table that was written here keeps the even columns it had as its rows came, for as long as
  // it is on the page: its cells never move, not when a row comes and not when it is whole.
  const [written, setWritten] = useState(node === context.writing);
  if (node === context.writing && !written) {
    setWritten(true);
  }
  const align = (column: number) => {
    const side = node.align?.[column];
    return side === null || side === undefined ? "start" : sides[side];
  };
  return (
    <Table
      aria-label={context.tableNames.get(node) ?? context.words.table}
      streaming={written}
    >
      {head !== undefined && (
        <TableHeader>
          <TableRow>
            {head.children.map((cell, column) => (
              <TableHead key={column} align={align(column)}>
                <Phrasing nodes={cell.children} context={context} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
      )}
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            {row.children.map((cell, column) => (
              <TableCell key={column} align={align(column)}>
                <Phrasing nodes={cell.children} context={context} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/** Each heading's look, by its depth in the answer: the first two a step up, the rest the body's. */
const headingLook = (depth: number, answerSize: Size) => {
  const major = depth <= 2;
  if (answerSize === "xs") {
    return styles.xsmallHeading;
  }
  if (answerSize === "sm") {
    return major ? styles.smallMajor : styles.smallMinor;
  }
  return major ? styles.major : styles.minor;
};

const headingTags = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

const Heading = ({
  node,
  context,
}: {
  node: HeadingNode;
  context: Context;
}) => {
  // The fifth and sixth depths are drawn and placed as the fourth, from the caller's level on.
  const depth = Math.min(node.depth, 4);
  const Tag =
    headingTags[Math.min(context.headingLevel - 1 + depth, 6) - 1] ?? "h6";
  return (
    <Tag
      {...stylex.props(
        styles.heading,
        headingLook(depth, context.size),
        context.greedy && styles.greedy
      )}
    >
      <Phrasing nodes={node.children} context={context} />
    </Tag>
  );
};

// Definitions are gathered (gather) and notes drawn at the foot; any other node is drawn inside a
// block, so it draws nothing here.
const Block = ({
  node,
  context,
}: {
  node: RootContent;
  context: Context;
}): ReactNode => {
  switch (node.type) {
    case "paragraph": {
      return (
        <p {...stylex.props(styles.paragraph, context.greedy && styles.greedy)}>
          <Phrasing
            nodes={node.children}
            context={inParagraph(node, context)}
          />
        </p>
      );
    }
    case "heading": {
      return <Heading node={node} context={context} />;
    }
    case "list": {
      return <ListBlock node={node} context={context} />;
    }
    case "blockquote": {
      return (
        <blockquote {...stylex.props(styles.quote)}>
          {node.children.map((child, index) => (
            <Block key={index} node={child} context={context} />
          ))}
        </blockquote>
      );
    }
    case "thematicBreak": {
      return <Separator />;
    }
    case "code": {
      return (
        <CodeBlock
          language={node.lang ?? "text"}
          // Still coming in while its fence is open at the end of an answer being written.
          streaming={node === context.openCode}
        >
          <CodeBlockHeader>
            <CodeBlockTitle />
            <CodeBlockActions>
              <CodeBlockCopyButton value={node.value} />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent lineNumbers maxLines={context.codeMaxLines}>
            {node.value}
          </CodeBlockContent>
        </CodeBlock>
      );
    }
    case "table": {
      return <TableBlock node={node} context={context} />;
    }
    case "html": {
      return (
        <p {...stylex.props(styles.paragraph, styles.raw)}>{node.value}</p>
      );
    }
    default: {
      return null;
    }
  }
};

/**
 * What the tree refers to from anywhere in it: link targets, the notes in reading order, and each
 * reference to a note counted in the order it is drawn (the answer, then the notes at its foot), so
 * each has its own id and drawing it twice (StrictMode) changes nothing.
 */
const gather = (nodes: RootContent[]) => {
  const definitions = new Map<
    string,
    { url: string; title: string | undefined }
  >();
  const found = new Map<string, FootnoteDefinition>();
  const order: string[] = [];
  eachNode(nodes, (node) => {
    if (node.type === "definition") {
      definitions.set(node.identifier, {
        url: node.url,
        title: node.title ?? undefined,
      });
    } else if (node.type === "footnoteDefinition") {
      found.set(node.identifier, node);
    } else if (
      node.type === "footnoteReference" &&
      !order.includes(node.identifier)
    ) {
      order.push(node.identifier);
    }
  });
  const notes = order.flatMap((id) => {
    const note = found.get(id);
    return note === undefined ? [] : [note];
  });
  // A reference inside a link is drawn as its number only, with no id: it is not counted.
  const references = new Map<RootContent, number>();
  const counted = new Map<string, number>();
  const count = (node: RootContent, inLink: boolean) => {
    if (node.type === "footnoteReference" && !inLink) {
      const nth = (counted.get(node.identifier) ?? 0) + 1;
      counted.set(node.identifier, nth);
      references.set(node, nth);
    }
  };
  eachNode(
    nodes.filter((node) => node.type !== "footnoteDefinition"),
    count
  );
  eachNode(notes, count);
  return { definitions, notes, references };
};

/** Each table's name: the words of the heading that stands above it. */
const nameTables = (blocks: RootContent[]) => {
  const names = new Map<RootContent, string>();
  let heading = "";
  for (const block of blocks) {
    if (block.type === "heading") {
      heading = spokenOf(block);
    }
    if (block.type === "table" && heading !== "") {
      names.set(block, heading);
    }
  }
  return names;
};

/** The notes at the foot, each leading back to where it was first used. */
const Notes = ({
  notes,
  context,
}: {
  notes: FootnoteDefinition[];
  context: Context;
}) => (
  <ol {...stylex.props(styles.footnotes)}>
    {notes.map((note, index) => (
      <li key={note.identifier} id={`${context.prefix}-fn-${index + 1}`}>
        {note.children.map((child, at) =>
          child.type === "paragraph" ? (
            <span key={at}>
              <Phrasing nodes={child.children} context={context} />{" "}
              <Link href={`#${context.prefix}-ref-${index + 1}-1`}>
                {context.words.back(index + 1)}
              </Link>
            </span>
          ) : (
            <Block key={at} node={child} context={context} />
          )
        )}
      </li>
    ))}
  </ol>
);

/**
 * What to draw of an answer: while it is written, made whole; once written, tidied if it may have
 * been cut off (it was streamed here, or the caller says so).
 */
const useAnswer = (source: string, streaming: boolean, truncated: boolean) => {
  const [streamed, setStreamed] = useState(streaming);
  if (streaming && !streamed) {
    setStreamed(true);
  }
  if (!streaming) {
    return {
      shown: truncated || streamed ? tidy(source) : source,
      kept: Number.POSITIVE_INFINITY,
      written: streamed,
    };
  }
  // `kept`: how much of it is the stream's own; past it, repair closed what was still open.
  const { text, kept } = repair(source);
  return { shown: text, kept, written: true };
};

/**
 * While an answer is written, a screen reader hears each block when it is finished (a paragraph,
 * a list, a heading), never each word. A table says its name; code says nothing here, as the
 * CodeBlock says it is being written. What was there when the answer was first drawn is not news.
 */
const useSaidBlocks = (
  blocks: RootContent[],
  live: boolean,
  said: boolean,
  names: Map<RootContent, string>,
  tableLabel: string
) => {
  const told = useRef<number | null>(null);
  // The last block may still be growing while more is coming.
  const finished = live ? Math.max(blocks.length - 1, 0) : blocks.length;
  useEffect(() => {
    const from = told.current;
    told.current = finished;
    if (!said || from === null || finished <= from) {
      return;
    }
    const words = blocks
      .slice(from, finished)
      .map((node) => {
        if (node.type === "code") {
          return "";
        }
        if (node.type === "html") {
          return sectionSaid(node.value);
        }
        return node.type === "table"
          ? (names.get(node) ?? tableLabel)
          : spokenOf(node).trim();
      })
      .filter((part) => part !== "")
      .join(" ");
    if (words !== "") {
      announce(words);
    }
  }, [blocks, finished, said, names, tableLabel]);
};

/** A line that defines a link's target or a note: `[name]: …` or `[^1]: …`. */
const DEFINES = /^ {0,3}\[[^\]\n]+\]:/mu;

/**
 * The answer's blocks. While it is written, only the block still being written is read again as
 * more of it comes (parse.ts, readBlocks): the blocks before it are finished and kept as they were
 * read, so a long answer costs no more to draw at its end than at its start. Once written, the kept
 * blocks stand and only the last is read again; it is read whole only when it defines a link or a
 * note further down, or is other words than were written.
 */
const useBlocks = (shown: string, live: boolean): Placed[] => {
  const [kept, setKept] = useState(NOTHING);
  if (
    !live &&
    (kept === NOTHING || DEFINES.test(shown) || !shown.startsWith(kept.text))
  ) {
    if (kept !== NOTHING) {
      setKept(NOTHING);
    }
    return parseMarkdown(shown).children.map((node) => ({ node, base: 0 }));
  }
  const read = readBlocks(shown, kept);
  if (read.kept !== kept) {
    setKept(read.kept);
  }
  return read.blocks;
};

/** Blocks with a frame of their own (code, a table, a rule) fade in whole; words come as words. */
const framed = new Set<RootContent["type"]>(["code", "table", "thematicBreak"]);

/**
 * A section (parse.ts, groupSections): the chevron before its summary, its blocks under the
 * summary's first letter, closed until it is opened. The toggle is named by the summary's words and
 * says whether it is open.
 */
const Section = ({
  grouped,
  context,
  children,
}: {
  grouped: Extract<Grouped, { type: "section" }>;
  context: Context;
  children: ReactNode;
}) => {
  const id = useId();
  const { base } = grouped.key;
  return (
    <Collapsible asChild defaultOpen={grouped.open}>
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
          <Phrasing
            nodes={grouped.summary}
            context={base === 0 ? context : { ...context, base }}
          />
        </div>
        <CollapsibleContent asChild>
          <div {...stylex.props(sectionStyles.under)}>
            <div {...stylex.props(sectionStyles.body)}>{children}</div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

/** One block, or a section holding its own. */
const GroupedBlock = ({
  grouped,
  context,
}: {
  grouped: Grouped;
  context: Context;
}): ReactNode => {
  if (grouped.type === "section") {
    return (
      <Section grouped={grouped} context={context}>
        {grouped.children.map((child, index) => (
          <GroupedBlock key={index} grouped={child} context={context} />
        ))}
      </Section>
    );
  }
  const { node, base } = grouped.placed;
  return (
    <div
      {...stylex.props(
        context.streaming && framed.has(node.type) && styles.arrives
      )}
    >
      <Block
        node={node}
        context={base === 0 ? context : { ...context, base }}
      />
    </div>
  );
};

/** An answer drawn from Markdown, safe while it streams. */
export const Markdown = ({
  children: source,
  streaming = false,
  truncated = false,
  live = "polite",
  size: answerSize = "default",
  headingLevel = 1,
  softBreaks = "space",
  codeMaxLines = 18,
  renderLink,
  style,
}: MarkdownProps) => {
  const words = useI18n().markdown;
  const prefix = useId().replaceAll(":", "");
  const { shown, kept, written } = useAnswer(
    bounded(source),
    streaming,
    truncated
  );
  const provided = use(ProvidedLinks);
  const all = useBlocks(shown, streaming);
  const { definitions, notes, references } = gather(
    all.map(({ node }) => node)
  );
  const placed = all.filter(
    ({ node }) =>
      node.type !== "definition" && node.type !== "footnoteDefinition"
  );
  const blocks = placed.map(({ node }) => node);
  const lastBlock = blocks.at(-1);
  const tableNames = nameTables(blocks);
  useSaidBlocks(blocks, streaming, live === "polite", tableNames, words.table);
  const context: Context = {
    definitions,
    renderLink,
    provided,
    kept,
    base: 0,
    footnotes: new Map(
      notes.map((note, index) => [note.identifier, index + 1])
    ),
    prefix,
    streaming,
    codeMaxLines,
    writing: streaming ? lastBlock : undefined,
    openCode:
      streaming && lastBlock?.type === "code" && openFence(shown)
        ? lastBlock
        : undefined,
    inLink: false,
    words,
    softBreaks,
    lineBreaks: false,
    size: answerSize,
    headingLevel,
    greedy: written,
    references,
    tableNames,
    Inline,
    Block,
  };
  return (
    <div
      data-slot="markdown"
      aria-busy={streaming || undefined}
      {...stylex.props(
        styles.root,
        answerSize === "message" && styles.message,
        answerSize === "sm" && styles.small,
        answerSize === "xs" && styles.xsmall,
        style
      )}
    >
      {groupSections(placed).map((grouped, index) => (
        // A block keeps its place by its order, so one that is already shown never fades in again.
        <GroupedBlock key={index} grouped={grouped} context={context} />
      ))}
      {notes.length > 0 && <Notes notes={notes} context={context} />}
    </div>
  );
};
