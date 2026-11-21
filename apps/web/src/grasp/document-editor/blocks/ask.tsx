// An Ask block: a question put to Grasp, its answer as ordinary blocks anyone may edit, and the
// sources it read at its foot, with a quiet line saying where it was asked and "Ask again", which
// writes that part again only (the host's `askAgain`): pending while Grasp writes, one step in the
// history, so undo brings the last answer back. In Markdown it is an open section headed by its
// question, so it reads well anywhere:
//
//   <details open data-grasp="ask" data-from="chat">
//   <summary>What slows down onboarding?</summary>
//
//   …the answer…
//
//   Sources: [Interview: Onboarding with finance](/brain/int-12), [Document: Checklist](/brain/doc-4)
//
//   </details>
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Node,
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import type {
  Editor,
  JSONContent,
  MarkdownLexerConfiguration,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
  NodeViewProps,
} from "@tiptap/react";
import { useState } from "react";

import { announce } from "../../announce/announce";
import { Button } from "../../button";
import { Cycle } from "../../icons";
import { Link } from "../../link";
import { Shimmer } from "../../shimmer";
import { grasp } from "../../tokens/tokens.stylex";
import { useBlocks } from "./context";
import type { AskAgainRequest } from "./context";

export interface AskSource {
  title: string;
  href: string;
}

const OPENING =
  /^<details\s+open\s+data-grasp="ask"(?:\s+data-from="(?<from>[a-z]+)")?\s*>[ \t]*\n[ \t]*<summary>(?<question>[^\n]*?)<\/summary>[ \t]*\n(?<body>[\s\S]*?)\n?<\/details>[ \t]*(?:\n|$)/u;
const SOURCES = /(?:^|\n)Sources: (?<line>[^\n]+)\s*$/u;
const LINK = /\[(?<title>[^\]\n]+)\]\((?<href>[^)\s]+)\)/gu;

const isSource = (value: unknown): value is AskSource =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "title") === "string" &&
  typeof Reflect.get(value, "href") === "string";

const sourcesOf = (value: unknown): AskSource[] =>
  Array.isArray(value) ? value.filter(isSource) : [];

const styles = stylex.create({
  block: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    margin: 0,
    paddingBlock: grasp.space4,
    paddingInline: grasp.space4,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: grasp.shellIconButton,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  from: { flexGrow: 1, minWidth: 0 },
  question: {
    margin: 0,
    fontSize: grasp.textLg,
    lineHeight: grasp.textLgLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    textWrap: "balance",
  },
  answer: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  pending: { opacity: grasp.dim },
  sources: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
    margin: 0,
    paddingBlockStart: grasp.space3,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
});

/** Writes the block again with the host's new answer, as one step in the history. */
const replaceAnswer = (editor: Editor, at: number, markdown: string) => {
  const node = editor.state.doc.nodeAt(at);
  if (node === null || node.type.name !== "ask") {
    return;
  }
  const parsed = editor.markdown?.parse(markdown);
  const content = (parsed?.content ?? []).filter(
    (child) => child.type !== undefined
  );
  const next = editor.schema.nodeFromJSON({
    type: "ask",
    attrs: node.attrs,
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  });
  editor.view.dispatch(
    editor.state.tr.replaceWith(at, at + node.nodeSize, next)
  );
};

const isJson = (value: unknown): value is JSONContent =>
  typeof value === "object" && value !== null;

/** The answer's Markdown now: the block's children written out. */
const answerOf = (editor: Editor, at: number) => {
  const node = editor.state.doc.nodeAt(at);
  if (node === null) {
    return "";
  }
  const children: unknown = node.content.toJSON();
  const content = Array.isArray(children) ? children.filter(isJson) : [];
  return editor.markdown?.serialize({ type: "doc", content }) ?? "";
};

/**
 * Asks the host again for the block at `at` and writes its answer in, saying what happens; resolves
 * once it is in or has failed. Outside the view: the compiler takes no `try` in a component.
 */
const askAgainFor = async (
  editor: Editor,
  at: number,
  question: string,
  ask: (request: AskAgainRequest) => Promise<string>,
  said: { asked: string; failed: string }
) => {
  try {
    replaceAnswer(
      editor,
      at,
      await ask({ kind: "ask", question, markdown: answerOf(editor, at) })
    );
    announce(said.asked);
  } catch {
    announce(said.failed);
  }
};

const AskView = ({ node, editor, getPos }: NodeViewProps) => {
  const { words, askAgain } = useBlocks();
  const [pending, setPending] = useState(false);
  const question = String(node.attrs.question ?? "");
  const sources = sourcesOf(node.attrs.sources);
  const again = async () => {
    const at = getPos();
    if (askAgain === undefined || typeof at !== "number") {
      return;
    }
    setPending(true);
    announce(words.askingAgain);
    await askAgainFor(editor, at, question, askAgain, {
      asked: words.askedAgain,
      failed: words.askFailed,
    });
    setPending(false);
  };
  const from =
    node.attrs.from === "chat" ? words.askedFromChat : words.askedHere;
  return (
    <NodeViewWrapper
      data-type="ask"
      aria-busy={pending || undefined}
      {...stylex.props(styles.block)}
    >
      <div contentEditable={false} {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.from)}>
          {pending ? <Shimmer>{words.askingAgain}</Shimmer> : from}
        </span>
        {askAgain === undefined ? null : (
          <Button
            variant="ghost"
            size="xs"
            icon={Cycle}
            disabled={pending}
            onClick={again}
          >
            {words.askAgain}
          </Button>
        )}
      </div>
      <p contentEditable={false} {...stylex.props(styles.question)}>
        {question}
      </p>
      <NodeViewContent {...stylex.props(pending && styles.pending)} />
      {sources.length === 0 ? null : (
        <p contentEditable={false} {...stylex.props(styles.sources)}>
          <span>{words.sources}</span>
          {sources.map((source) => (
            <Link key={source.href} href={source.href}>
              {source.title}
            </Link>
          ))}
        </p>
      )}
    </NodeViewWrapper>
  );
};

/** The token of a whole Ask block: its question, where it was asked, its sources and its body's blocks. */
const askToken = (
  match: RegExpExecArray,
  lexer: MarkdownLexerConfiguration
): MarkdownToken => {
  let body = (match.groups?.body ?? "").trim();
  const line = SOURCES.exec(body);
  const sources: AskSource[] = [];
  if (line !== null) {
    body = body.slice(0, line.index).trim();
    for (const link of (line.groups?.line ?? "").matchAll(LINK)) {
      sources.push({
        title: link.groups?.title ?? "",
        href: link.groups?.href ?? "",
      });
    }
  }
  return {
    type: "ask",
    raw: match[0],
    question: (match.groups?.question ?? "").trim(),
    from: match.groups?.from ?? "chat",
    sources,
    tokens: lexer.blockTokens(body),
  };
};

export const Ask = Node.create({
  name: "ask",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      question: { default: "" },
      from: { default: "chat" },
      sources: { default: [] },
    };
  },
  parseHTML() {
    return [{ tag: "section[data-type=ask]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["section", { ...HTMLAttributes, "data-type": "ask" }, 0];
  },
  addNodeView() {
    const render = ReactNodeViewRenderer(AskView);
    // Tiptap keeps the answer's blocks in a holder of its own inside NodeViewContent: it takes the
    // page's column of blocks, so the answer keeps the page's rhythm.
    return (props) => {
      const view = render(props);
      if (
        "contentDOMElement" in view &&
        view.contentDOMElement instanceof HTMLElement
      ) {
        view.contentDOMElement.className =
          stylex.props(styles.answer).className ?? "";
      }
      return view;
    };
  },
  markdownTokenizer: {
    name: "ask",
    level: "block",
    start: (source: string) =>
      source.search(/^<details\s+open\s+data-grasp="ask"/mu),
    tokenize: (
      source: string,
      _tokens: MarkdownToken[],
      lexer: MarkdownLexerConfiguration
    ) => {
      const match = OPENING.exec(source);
      return match === null ? undefined : askToken(match, lexer);
    },
  },
  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    const body = helpers.parseChildren(token.tokens ?? []);
    return {
      type: "ask",
      attrs: {
        question: String(token.question ?? ""),
        from: String(token.from ?? "chat"),
        sources: sourcesOf(token.sources),
      },
      content: body.length > 0 ? body : [{ type: "paragraph" }],
    };
  },
  renderMarkdown: (node: JSONContent, helpers: MarkdownRendererHelpers) => {
    const question = String(node.attrs?.question ?? "").replaceAll("\n", " ");
    const from = String(node.attrs?.from ?? "chat");
    const inside = helpers.renderChildren(node.content ?? [], "\n\n").trim();
    const sources = sourcesOf(node.attrs?.sources);
    const foot =
      sources.length === 0
        ? ""
        : `\n\nSources: ${sources.map((source) => `[${source.title}](${source.href})`).join(", ")}`;
    return `<details open data-grasp="ask" data-from="${from}">\n<summary>${question}</summary>\n\n${inside}${foot}\n\n</details>`;
  },
});
