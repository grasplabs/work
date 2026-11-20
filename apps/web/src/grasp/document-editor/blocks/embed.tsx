// An embed: a card for another thing in the product (an interview, a document, a note, an App) that
// opens it. In Markdown it is one link line on its own, so it reads as a link anywhere:
//
//   [Interview: Onboarding with finance](/brain/interviews/int-12)
//
// The kind word is part of the format, in English, as a link's scheme is; the card says the kind in
// the product's words.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Node, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { JSONContent, MarkdownToken, NodeViewProps } from "@tiptap/react";

import { focus } from "../../focus/focus";
import {
  AppWindow,
  Conversation,
  External,
  File,
  Icon,
  Note,
} from "../../icons";
import type { IconData } from "../../icons";
import { grasp, media } from "../../tokens/tokens.stylex";
import { useBlocks } from "./context";

/** The kinds, as the Markdown names them. */
export const embedKinds = ["Interview", "Document", "Note", "App"] as const;
export type EmbedKind = (typeof embedKinds)[number];

const isKind = (value: string): value is EmbedKind =>
  embedKinds.some((kind) => kind === value);

/** What a node with no kind we know is taken for: a document. */
const [, fallbackKind] = embedKinds;

/** A node's kind, or Document when it names none we know. */
const kindOf = (value: unknown): EmbedKind => {
  const kind = String(value);
  return isKind(kind) ? kind : fallbackKind;
};

const icons: Record<EmbedKind, IconData> = {
  Interview: Conversation,
  Document: File,
  Note,
  App: AppWindow,
};

/** A line that is one embed: `[Kind: Title](address)` and nothing else. */
const LINE =
  /^\[(?<kind>Interview|Document|Note|App): (?<title>[^\]\n]+)\]\((?<href>[^)\s]+)\)[ \t]*(?:\n|$)/u;

const styles = stylex.create({
  wrapper: { margin: 0 },
  card: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    maxWidth: "100%",
    paddingBlock: grasp.space3,
    paddingInline: grasp.space3,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: grasp.raised,
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
    },
    boxShadow: grasp.edge,
    color: grasp.ink,
    textDecorationLine: "none",
  },
  selected: { boxShadow: `${grasp.edge}, ${grasp.fieldFocus}` },
  tile: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: grasp.space8,
    height: grasp.space8,
    borderRadius: grasp.cornerMark,
    backgroundColor: grasp.soft,
    color: grasp.muted,
  },
  words: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  // A quiet mark at the card's end, so it reads as a thing that opens; the whole card stays the target.
  open: { display: "inline-flex", flexShrink: 0, color: grasp.muted },
  title: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: grasp.weightMedium,
  },
  kind: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
});

const EmbedCard = ({ node, selected }: NodeViewProps) => {
  const { words } = useBlocks();
  const kind = kindOf(node.attrs.kind);
  const title = String(node.attrs.title ?? "");
  return (
    <NodeViewWrapper
      data-type="embed"
      data-kind={kind}
      {...stylex.props(styles.wrapper)}
    >
      <a
        href={String(node.attrs.href ?? "")}
        contentEditable={false}
        draggable={false}
        {...stylex.props(styles.card, selected && styles.selected, focus.ring)}
      >
        <span aria-hidden="true" {...stylex.props(styles.tile)}>
          <Icon icon={icons[kind]} />
        </span>
        <span {...stylex.props(styles.words)}>
          <span {...stylex.props(styles.title)}>{title}</span>
          <span {...stylex.props(styles.kind)}>{words.embedKinds[kind]}</span>
        </span>
        <span aria-hidden="true" {...stylex.props(styles.open)}>
          <Icon icon={External} />
        </span>
      </a>
    </NodeViewWrapper>
  );
};

export const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      kind: { default: fallbackKind },
      title: { default: "" },
      href: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-type=embed]" }];
  },
  renderHTML({ node }) {
    return [
      "div",
      { "data-type": "embed", "data-kind": String(node.attrs.kind) },
      [
        "a",
        { href: String(node.attrs.href) },
        `${String(node.attrs.kind)}: ${String(node.attrs.title)}`,
      ],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EmbedCard);
  },
  markdownTokenizer: {
    name: "embed",
    level: "block",
    start: (source: string) =>
      source.search(/^\[(?:Interview|Document|Note|App): /mu),
    tokenize: (source: string) => {
      const match = LINE.exec(source);
      return match === null
        ? undefined
        : {
            type: "embed",
            raw: match[0],
            kind: match.groups?.kind,
            title: match.groups?.title,
            href: match.groups?.href,
          };
    },
  },
  parseMarkdown: (token: MarkdownToken) => ({
    type: "embed",
    attrs: {
      kind: kindOf(token.kind),
      title: String(token.title ?? ""),
      href: String(token.href ?? ""),
    },
  }),
  renderMarkdown: (node: JSONContent) =>
    `[${kindOf(node.attrs?.kind)}: ${String(node.attrs?.title ?? "")}](${String(node.attrs?.href ?? "")})`,
});
