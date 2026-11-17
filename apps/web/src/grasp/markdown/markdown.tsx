// Markdown: an agent's answer, drawn from Markdown. Headings, paragraphs, lists and tasks, tables
// (Grasp's Table), quotes, rules, links (Grasp's Link), code in a sentence, and fenced code
// (Grasp's Code block). From a syntax tree, never as HTML: raw HTML in the source shows as the text
// it is, and a link leads only to http, https or mailto. While it streams, the words are let out at
// a steady pace, each fading in with nothing round it (src/motion/use-paced.ts,
// src/motion/use-arriving.ts), and what is half-written is made whole
// (repair.ts): bold is bold from its first letter, a table is a table from its first row, an open
// fence shows as code still being written. Nothing flickers or re-flows when a mark closes.
//
//   <Markdown source={answer} />
//   <Markdown source={partial} streaming />
//
// It is a Chat message's body: <ChatMessage from="agent"><Markdown source={answer} /></ChatMessage>.
// The type is the interface's own, from the tokens only.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Fragment,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { FC, ReactNode } from "react";

import { announce } from "../announce/announce";
import { CodeBlock } from "../code-block";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, Tick } from "../icons";
import { Link } from "../link";
import { useArriving } from "../motion/use-arriving";
import { ArrivingContext, usePaced } from "../motion/use-paced";
import type { PacedOptions } from "../motion/use-paced";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../table";
import { useWords, withGiven } from "../words/words";
import { NOTHING, readBlocks } from "./blocks";
import type { Placed } from "./blocks";
import { parse, safeHref, schemeOf } from "./parse";
import { openFence, repair, tidy } from "./repair";
import { markdownStyles as styles } from "./styles";
import type {
  FootnoteDefinition,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table as TableNode,
} from "./types";
import { markdownWords } from "./words";

/** What a host may draw in a link's place: anything React draws at once (never a promise). */
export type MarkdownDrawn = Exclude<ReactNode, Promise<unknown>>;

/** A link in the answer, as the host's `renderLink` sees it. */
export interface MarkdownLink {
  /** The address exactly as the source has it (never resolved against the page), any scheme. */
  href: string;
  /** The address's scheme as a browser reads it, in lower case (`javascript`, `grasp`); empty for none. */
  scheme: string;
  /** The link's title, when the source gives one: `[words](url "title")`. */
  title?: string;
  /** What the link says: its words, drawn as Markdown draws them; for a picture, its alt words. */
  children: ReactNode;
  /** `link` for `[words](url)` and a reference, `autolink` for a bare address, `image` for a picture. */
  kind: "link" | "image" | "autolink";
}

/** How a single newline inside a paragraph is drawn: a space, a line break, or a break only in a paragraph of short lines. */
export type MarkdownSoftBreaks = "space" | "line" | "auto";

/** Every prop a Markdown takes. */
export interface MarkdownProps {
  /** The Markdown: the agent's answer, or as much of it as has arrived. */
  source: string;
  /** The answer is still being written: its words come at a steady pace, and what is half-written is shown whole. */
  streaming?: boolean;
  /**
   * The answer was cut off part way (stopped): a link still being written at its end goes, and
   * bold or code left open is closed, so no raw mark shows. Once `streaming` turns false on an
   * answer written here this happens by itself; set it for a cut answer drawn from history.
   * @default false
   */
  cut?: boolean;
  /**
   * How fast the words come while it is written: `calm`, `steady` or `quick`.
   * @default "quick"
   */
  pace?: PacedOptions["pace"];
  /**
   * `md` for an answer in a thread; `sm` for words in a card or a panel (an agent's instructions,
   * a note), a step smaller, its headings too; `xs` a step smaller again, for a note beside the
   * answer (an agent's thoughts).
   * @default "md"
   */
  size?: "md" | "sm" | "xs";
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
   * Fenced code past this many lines is folded under Show more, as Code block's `maxLines`.
   * @default 18
   */
  codeMaxLines?: number | false;
  /**
   * What a link that leaves the product says to a screen reader, after its words.
   * @default "opens in a new tab"
   */
  externalLabel?: string;
  /**
   * The link from a footnote back to where it is used, in the page's language, from its number.
   * @default (number) => `Back to reference ${number}`
   */
  backLabel?: (number: number) => string;
  /**
   * A footnote's mark, said to a screen reader, from its number.
   * @default (number) => `Footnote ${number}`
   */
  footnoteLabel?: (number: number) => string;
  /**
   * What a ticked task says to a screen reader.
   * @default "Done"
   */
  doneLabel?: string;
  /**
   * What a task not yet ticked says.
   * @default "Not done"
   */
  notDoneLabel?: string;
  /**
   * A table's name when no heading stands above it; one with a heading takes the heading's words.
   * @default "Table"
   */
  tableLabel?: string;
  /**
   * The host draws the answer's links: called for every link and picture in the text, whatever its
   * scheme, before Markdown's own filter, and what it returns is drawn in its place (a button that
   * asks before leaving, a Sources claim). Return undefined for Markdown's own: http, https and
   * mailto as a Link, anything else as its words. A link it draws gets no anchor from Markdown.
   * Footnote marks and their way back stay Markdown's own. While an answer streams, its last link's
   * address can still grow: it is called again as it does. It returns a `MarkdownDrawn`: anything
   * React draws at once, never a promise (the product's lint refuses a component that may return one).
   */
  renderLink?: (link: MarkdownLink) => MarkdownDrawn | undefined;
}

interface Context {
  /** Each link definition's target and title, by its identifier. */
  definitions: Map<string, { url: string; title: string | undefined }>;
  /** The host's own drawing of a link, when it has one. */
  renderLink: MarkdownProps["renderLink"];
  footnotes: Map<string, number>;
  prefix: string;
  /** Still being written, or its last words still arriving. */
  streaming: boolean;
  codeMaxLines: number | false;
  externalLabel: string;
  /** The block still being written, at the end of an answer that is. */
  writing: RootContent | undefined;
  /** The fence still being written, at the end of an answer that is: the one Code block that streams. */
  openCode: RootContent | undefined;
  /** Inside a link: a picture or a note's mark there is words, never a link in a link. */
  inLink: boolean;
  footnoteLabel: (number: number) => string;
  doneLabel: string;
  notDoneLabel: string;
  tableLabel: string;
  /** How a single newline is drawn (`softBreaks`). */
  softBreaks: MarkdownSoftBreaks;
  /** This paragraph draws its single newlines as line breaks. */
  lineBreaks: boolean;
  /** The smaller size, for words in a card. */
  small: boolean;
  /** A step smaller again (`size="xs"`). */
  xsmall: boolean;
  /**
   * Written here, word by word: its lines break where they fill, never weighed again as a word
   * comes (pretty and balanced wrapping move earlier words to a new line as the last line grows).
   */
  greedy: boolean;
  /** How many times each note has been referred to so far, for each reference's own id. */
  seen: Map<number, number>;
  /** Each table's name: the words of the heading above it. */
  tableNames: Map<RootContent, string>;
  /** The parts that draw a phrase and a block, handed down so the parts above can draw them. */
  Inline: FC<{ node: PhrasingContent; context: Context }>;
  Block: FC<{ node: RootContent; context: Context }>;
}

type Linked = Extract<PhrasingContent, { type: "link" | "linkReference" }>;
type Pictured = Extract<PhrasingContent, { type: "image" | "imageReference" }>;
type NoteReference = Extract<PhrasingContent, { type: "footnoteReference" }>;

/** A link's target, from a link or a reference to a definition; null when it may not be followed. */
const hrefOf = (url: string | undefined): string | null =>
  url === undefined || url === "" ? null : safeHref(url);

/** Every node's words, run together: a heading's, to name the table under it. */
const wordsOf = (node: Root | RootContent): string => {
  if ("value" in node) {
    return node.value;
  }
  if ("children" in node) {
    return node.children.map(wordsOf).join("");
  }
  return "";
};

/** Each level of heading, as a tag and its type: the fifth and sixth as the fourth. */
const headings = {
  1: { tag: "h1", level: 1 },
  2: { tag: "h2", level: 2 },
  3: { tag: "h3", level: 3 },
  4: { tag: "h4", level: 4 },
  5: { tag: "h4", level: 4 },
  6: { tag: "h4", level: 4 },
} as const;

const levelStyles = {
  1: styles.h1,
  2: styles.h2,
  3: styles.h3,
  4: styles.h4,
} as const;

/** A table column's side, from the source's colons. */
const sides = { left: "start", right: "end", center: "center" } as const;

/** A block's words as they are said: its phrases run together, its parts (a list's items) apart. */
const spokenOf = (node: Root | RootContent): string => {
  if ("value" in node) {
    return node.value;
  }
  if (!("children" in node)) {
    return "";
  }
  const parts = node.children.map(spokenOf);
  return node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "tableCell"
    ? parts.join("")
    : parts.join(" ");
};

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
 * never breaks at all. Nothing that was drawn on its own line is ever drawn back onto another.
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

/**
 * Whether a link still being written will get an arrow, as far as its address tells yet: no address
 * so far, or the start of a web address. An address that starts any other way (mailto:) gets none,
 * so no room is kept for one from its first letters on.
 */
const isComing = (url: string | undefined) =>
  url === undefined ||
  url === "#" ||
  "https://".startsWith(url) ||
  "http://".startsWith(url) ||
  /^https?:\/\//u.test(url);

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
  if (only?.type !== "text") {
    return false;
  }
  return [only.value, `http://${only.value}`, `mailto:${only.value}`].includes(
    node.url
  );
};

/**
 * An address repair.ts put in while the link is still being written (`#`, or the first letters of
 * a web address): not yet the link's own, so the host is not asked about it.
 */
const isPlaceholder = (url: string | undefined, context: Context) =>
  context.streaming &&
  (url === undefined ||
    url === "#" ||
    "https://".startsWith(url) ||
    "http://".startsWith(url));

/** What the host draws for a link, or undefined for Markdown's own. */
const hosted = (
  context: Context,
  link: Omit<MarkdownLink, "scheme" | "title"> & { title: string | undefined }
): MarkdownDrawn | undefined => {
  const { title, ...rest } = link;
  const asked = {
    ...rest,
    scheme: schemeOf(link.href),
    ...(title === undefined ? {} : { title }),
  };
  return context.renderLink === undefined || context.inLink
    ? undefined
    : context.renderLink(asked);
};

const LinkInline = ({ node, context }: { node: Linked; context: Context }) => {
  const { url, title } = targetOf(node, context);
  const words = (
    <Phrasing nodes={node.children} context={{ ...context, inLink: true }} />
  );
  if (url !== undefined && !isPlaceholder(url, context)) {
    const drawn = hosted(context, {
      href: url,
      title,
      children: words,
      kind: isAutolink(node) ? "autolink" : "link",
    });
    if (drawn !== undefined) {
      return drawn;
    }
  }
  const href = hrefOf(url);
  if (href === null || context.inLink) {
    // A link still being written has no address yet (repair.ts gives it `#`, or the start of
    // one): its words, with the room its arrow will take, so the words after it never move when
    // the address is whole.
    const coming = context.streaming && !context.inLink && isComing(url);
    return coming ? (
      <>
        {words}
        <span
          aria-hidden="true"
          data-arrow-room=""
          {...stylex.props(styles.arrowRoom)}
        />
      </>
    ) : (
      words
    );
  }
  return (
    <Link
      href={href}
      external={!href.startsWith("mailto:")}
      externalLabel={context.externalLabel}
    >
      {words}
    </Link>
  );
};

// A picture is never loaded (no request leaves for it): it is shown by its words, and leads to the
// picture when it may, or is drawn by the host.
const PictureInline = ({
  node,
  context,
}: {
  node: Pictured;
  context: Context;
}) => {
  const { url, title } = targetOf(node, context);
  const alt = node.alt ?? "";
  if (url !== undefined && url !== "") {
    const drawn = hosted(context, {
      href: url,
      title,
      children: alt,
      kind: "image",
    });
    if (drawn !== undefined) {
      return drawn;
    }
  }
  const href = hrefOf(url);
  const words = alt === "" ? (href ?? "") : alt;
  if (href === null || context.inLink) {
    return words;
  }
  return (
    <Link href={href} external externalLabel={context.externalLabel}>
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
  const nth = (context.seen.get(number) ?? 0) + 1;
  context.seen.set(number, nth);
  return (
    <sup {...stylex.props(styles.footnoteMark)}>
      <span id={`${context.prefix}-ref-${number}-${nth}`}>
        <Link href={`#${context.prefix}-fn-${number}`}>
          <span aria-label={context.footnoteLabel(number)}>
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
            context.xsmall && styles.xsmallCode
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
  const done = item.checked;
  return (
    <li {...stylex.props(styles.item, styles.task)}>
      <span aria-hidden {...stylex.props(styles.box, done && styles.boxDone)}>
        {done && <Icon icon={Tick} />}
      </span>
      <span data-task-state="" {...stylex.props(visuallyHidden)}>
        {done ? context.doneLabel : context.notDoneLabel}
      </span>
      {body}
    </li>
  );
};

const ListBlock = ({ node, context }: { node: List; context: Context }) => {
  const items = node.children.map((item, index) => (
    <Item key={index} item={item} context={context} />
  ));
  if (node.ordered === true) {
    return (
      <ol
        start={node.start ?? undefined}
        {...stylex.props(styles.list, styles.ordered)}
      >
        {items}
      </ol>
    );
  }
  return <ul {...stylex.props(styles.list, styles.unordered)}>{items}</ul>;
};

// A row arrives whole, when its line has ended (repair.ts), so its cells fade in together.
const Cell = ({
  nodes,
  context,
}: {
  nodes: PhrasingContent[];
  context: Context;
}) => <Phrasing nodes={nodes} context={context} />;

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
      aria-label={context.tableNames.get(node) ?? context.tableLabel}
      arriving={written}
    >
      {head !== undefined && (
        <TableHeader>
          <TableRow>
            {head.children.map((cell, column) => (
              <TableHead key={column} align={align(column)}>
                <Cell nodes={cell.children} context={context} />
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
                <Cell nodes={cell.children} context={context} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const Heading = ({
  node,
  context,
}: {
  node: Extract<RootContent, { type: "heading" }>;
  context: Context;
}) => {
  const { tag: Tag, level } = headings[node.depth];
  const small = level <= 2 ? styles.smallHeading : styles.smallMinor;
  return (
    <Tag
      {...stylex.props(
        styles.heading,
        levelStyles[level],
        context.small && small,
        context.xsmall && styles.xsmallHeading,
        context.greedy && styles.greedy
      )}
    >
      <Phrasing nodes={node.children} context={context} />
    </Tag>
  );
};

// Definitions lead links and notes are drawn at the foot; any other node is drawn inside a block,
// so it draws nothing here.
const Block = ({
  node,
  context,
}: {
  node: RootContent;
  context: Context;
}): ReactNode => {
  if (node.type === "paragraph") {
    return (
      <p {...stylex.props(styles.paragraph, context.greedy && styles.greedy)}>
        <Phrasing nodes={node.children} context={inParagraph(node, context)} />
      </p>
    );
  }
  if (node.type === "heading") {
    return <Heading node={node} context={context} />;
  }
  if (node.type === "list") {
    return <ListBlock node={node} context={context} />;
  }
  if (node.type === "blockquote") {
    return (
      <blockquote {...stylex.props(styles.quote)}>
        {node.children.map((child, index) => (
          <Block key={index} node={child} context={context} />
        ))}
      </blockquote>
    );
  }
  if (node.type === "thematicBreak") {
    return <hr {...stylex.props(styles.rule)} />;
  }
  if (node.type === "code") {
    return (
      <CodeBlock
        code={node.value}
        language={node.lang ?? "text"}
        maxLines={context.codeMaxLines}
        // Still coming in while its fence is open at the end of an answer being written.
        streaming={node === context.openCode}
      />
    );
  }
  if (node.type === "table") {
    return <TableBlock node={node} context={context} />;
  }
  if (node.type === "html") {
    return <p {...stylex.props(styles.paragraph, styles.raw)}>{node.value}</p>;
  }
  return null;
};

/** What the tree refers to from anywhere in it: link targets, notes, and notes in reading order. */
const gather = (nodes: RootContent[]) => {
  const definitions = new Map<
    string,
    { url: string; title: string | undefined }
  >();
  const found = new Map<string, FootnoteDefinition>();
  const order: string[] = [];
  const walk = (node: Root | RootContent) => {
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
    if ("children" in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  for (const node of nodes) {
    walk(node);
  }
  const notes = order.flatMap((id) => {
    const note = found.get(id);
    return note === undefined ? [] : [note];
  });
  return { definitions, notes };
};

/** Each table's name: the words of the heading that stands above it. */
const nameTables = (blocks: RootContent[]) => {
  const names = new Map<RootContent, string>();
  let heading = "";
  for (const block of blocks) {
    if (block.type === "heading") {
      heading = wordsOf(block);
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
  backLabel,
}: {
  notes: FootnoteDefinition[];
  context: Context;
  backLabel: (number: number) => string;
}) => (
  <ol {...stylex.props(styles.footnotes)}>
    {notes.map((note, index) => (
      <li key={note.identifier} id={`${context.prefix}-fn-${index + 1}`}>
        {note.children.map((child, at) =>
          child.type === "paragraph" ? (
            <span key={at}>
              <Phrasing nodes={child.children} context={context} />{" "}
              <Link href={`#${context.prefix}-ref-${index + 1}-1`}>
                {backLabel(index + 1)}
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
 * What to draw of an answer: all of it once it is written, tidied if it may have been cut off;
 * while it is, as much as the pace has let out, made whole.
 */
const useAnswer = (
  source: string,
  streaming: boolean,
  cut: boolean,
  options: PacedOptions
) => {
  const paced = usePaced(source, streaming, options);
  // Written here: once the stream ends, whatever it ended on is tidied.
  const [streamed, setStreamed] = useState(streaming);
  if (streaming && !streamed) {
    setStreamed(true);
  }
  // Still being written until the last word is out, a moment after the stream has ended.
  if (!streaming && paced.done) {
    return { shown: cut || streamed ? tidy(source) : source, live: false };
  }
  return { shown: repair(paced.text).text, live: true };
};

/**
 * While an answer is written, a screen reader hears each block when it is finished (a paragraph,
 * a list, a heading), never each word. A table says its name; code says nothing here, as the Code
 * block says it is being written. What was there when the answer was first drawn is not news.
 */
const useSaidBlocks = (
  blocks: RootContent[],
  live: boolean,
  names: Map<RootContent, string>,
  tableLabel: string
) => {
  const said = useRef<number | null>(null);
  // The last block may still be growing while more is coming.
  const finished = live ? Math.max(blocks.length - 1, 0) : blocks.length;
  useEffect(() => {
    const from = said.current;
    said.current = finished;
    if (from === null || finished <= from) {
      return;
    }
    const words = blocks
      .slice(from, finished)
      .map((node) => {
        if (node.type === "code") {
          return "";
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
  }, [blocks, finished, names, tableLabel]);
};

/** A line that defines a link's target or a note: `[name]: …` or `[^1]: …`. */
const DEFINES = /^ {0,3}\[[^\]\n]+\]:/mu;

/**
 * The answer's blocks. Written, it is read whole. While it is written, only the block still being
 * written is read again as more of it comes (blocks.ts): the blocks before it are finished, and
 * are kept as they were read, so a long answer costs no more to draw at its end than at its start.
 */
const useBlocks = (shown: string, live: boolean): Placed[] => {
  const [kept, setKept] = useState(NOTHING);
  // Once written, the blocks kept as it was written stand, and only the last is read again: reading
  // a long answer whole when it ends is a long task on a slow phone. It is read whole only when it
  // defines a link or a note further down (blocks.ts), or is other words than were written.
  if (
    !live &&
    (kept === NOTHING || DEFINES.test(shown) || !shown.startsWith(kept.text))
  ) {
    if (kept !== NOTHING) {
      setKept(NOTHING);
    }
    return parse(shown).children.map((node) => ({ node, base: 0 }));
  }
  const read = readBlocks(shown, kept);
  if (read.kept !== kept) {
    setKept(read.kept);
  }
  return read.blocks;
};

/** Blocks with a frame of their own (code, a table, a rule) fade in whole; words fade in as words. */
const framed = new Set<RootContent["type"]>(["code", "table", "thematicBreak"]);

/**
 * An answer written on the page: its words fade in as they arrive, with nothing round any word
 * (inside a Chat message, the message's words' box does it for them), and it keeps lines that break
 * where they fill for as long as it is on the page, so no line is weighed again, not as words come
 * and not when it is whole.
 */
const useWrittenHere = (live: boolean) => {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const inMessage = useContext(ArrivingContext) !== null;
  useArriving(inMessage ? null : root, live);
  const [written, setWritten] = useState(live);
  if (live && !written) {
    setWritten(true);
  }
  return { setRoot, written };
};

/** An answer drawn from Markdown, safe while it streams. */
export const Markdown = ({
  source,
  streaming = false,
  cut = false,
  pace,
  size = "md",
  softBreaks = "space",
  codeMaxLines = 18,
  externalLabel,
  backLabel,
  footnoteLabel,
  doneLabel,
  notDoneLabel,
  tableLabel,
  renderLink,
}: MarkdownProps) => {
  // Its words: the product's, by its catalogue, else English; a text prop given still wins.
  const text = withGiven(useWords("markdown", markdownWords), {
    external: externalLabel,
    back: backLabel,
    footnote: footnoteLabel,
    done: doneLabel,
    notDone: notDoneLabel,
    table: tableLabel,
  });
  const prefix = useId().replaceAll(":", "");
  const { shown, live } = useAnswer(source, streaming, cut, { pace });
  const { setRoot, written } = useWrittenHere(live);
  const all = useBlocks(shown, live);
  const { definitions, notes } = gather(all.map(({ node }) => node));
  const placed = all.filter(
    ({ node }) =>
      node.type !== "definition" && node.type !== "footnoteDefinition"
  );
  const blocks = placed.map(({ node }) => node);
  const footnotes = new Map(
    notes.map((note, index) => [note.identifier, index + 1])
  );
  const lastBlock = blocks.at(-1);
  const tableNames = nameTables(blocks);
  useSaidBlocks(blocks, live, tableNames, text.table);
  const context: Context = {
    definitions,
    renderLink,
    footnotes,
    prefix,
    streaming: live,
    codeMaxLines,
    externalLabel: text.external,
    writing: live ? lastBlock : undefined,
    openCode:
      live && lastBlock?.type === "code" && openFence(shown)
        ? lastBlock
        : undefined,
    inLink: false,
    footnoteLabel: text.footnote,
    doneLabel: text.done,
    notDoneLabel: text.notDone,
    tableLabel: text.table,
    softBreaks,
    lineBreaks: false,
    small: size === "sm",
    xsmall: size === "xs",
    greedy: written,
    seen: new Map(),
    tableNames,
    Inline,
    Block,
  };
  return (
    <div
      ref={setRoot}
      data-slot="markdown"
      aria-busy={live || undefined}
      {...stylex.props(
        styles.root,
        size === "sm" && styles.small,
        size === "xs" && styles.xsmall
      )}
    >
      {placed.map(({ node }, index) => (
        // A block keeps its place by its order, so one that is already shown never fades in again.
        <Fragment key={index}>
          <div
            {...stylex.props(live && framed.has(node.type) && styles.arrives)}
          >
            <Block node={node} context={context} />
          </div>
        </Fragment>
      ))}
      {notes.length > 0 && (
        <Notes notes={notes} context={context} backLabel={text.back} />
      )}
    </div>
  );
};
