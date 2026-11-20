// Ask again for one part of a page, from the gutter's block menu: a section (its summary is the
// question) or an Ask block. The host's `onAskAgain` answers with the part's new Markdown; the part is
// marked pending meanwhile and is written again as one step in the history, its question kept.
import type { Editor, JSONContent } from "@tiptap/react";

import { announce } from "../../announce/announce";
import { setPending } from "./commands";
import type { TopBlock } from "./commands";
import type { AskAgainRequest } from "./context";

const isJson = (value: unknown): value is JSONContent =>
  typeof value === "object" && value !== null;

/** A node's children, as JSON. */
const childrenOf = (value: unknown): JSONContent[] =>
  Array.isArray(value) ? value.filter(isJson) : [];

/** What the part asks, and its Markdown now; null for a block that is neither. */
const requestOf = (editor: Editor, block: TopBlock): AskAgainRequest | null => {
  const node = editor.state.doc.nodeAt(block.pos);
  if (node === null) {
    return null;
  }
  if (node.type.name === "ask") {
    const content = childrenOf(node.content.toJSON());
    return {
      kind: "ask",
      question: String(node.attrs.question ?? ""),
      markdown: editor.markdown?.serialize({ type: "doc", content }) ?? "",
    };
  }
  if (node.type.name === "details") {
    const summary = node.firstChild?.textContent ?? "";
    const content = childrenOf(node.lastChild?.content.toJSON());
    return {
      kind: "section",
      question: summary,
      markdown: editor.markdown?.serialize({ type: "doc", content }) ?? "",
    };
  }
  return null;
};

/** Whether a block can be asked again. */
export const canAskAgain = (type: string) =>
  type === "ask" || type === "details";

/** The part again, with its new body: an Ask block keeps its question and sources, a section its summary. */
const rewritten = (
  editor: Editor,
  block: TopBlock,
  markdown: string
): JSONContent | null => {
  const node = editor.state.doc.nodeAt(block.pos);
  const parsed = childrenOf(editor.markdown?.parse(markdown).content);
  const body = parsed.length > 0 ? parsed : [{ type: "paragraph" }];
  if (node === null) {
    return null;
  }
  if (node.type.name === "ask") {
    return { type: "ask", attrs: node.attrs, content: body };
  }
  const summary: unknown = node.firstChild?.toJSON();
  return {
    type: "details",
    attrs: node.attrs,
    content: [
      isJson(summary) ? summary : { type: "detailsSummary" },
      { type: "detailsContent", content: body },
    ],
  };
};

/** Asks again for a block, says what happens, and writes the answer in. Resolves when done or failed. */
export const askAgainBlock = async (
  editor: Editor,
  block: TopBlock,
  ask: (request: AskAgainRequest) => Promise<string>,
  said: { asking: string; asked: string; failed: string }
) => {
  const request = requestOf(editor, block);
  if (request === null) {
    return;
  }
  setPending(editor, block, true);
  announce(said.asking);
  try {
    const markdown = await ask(request);
    setPending(editor, block, false);
    const next = rewritten(editor, block, markdown);
    if (next !== null) {
      const node = editor.state.doc.nodeAt(block.pos);
      editor.view.dispatch(
        editor.state.tr.replaceWith(
          block.pos,
          block.pos + (node?.nodeSize ?? block.size),
          editor.schema.nodeFromJSON(next)
        )
      );
    }
    announce(said.asked);
  } catch {
    setPending(editor, block, false);
    announce(said.failed);
  }
};

/**
 * Starts asking again from a menu item, which waits for nothing: askAgainBlock catches and says its
 * own failure, so its promise never rejects.
 */
export const startAskAgain = (...args: Parameters<typeof askAgainBlock>) => {
  // oxlint-disable-next-line typescript/no-floating-promises -- it never rejects (above)
  askAgainBlock(...args);
};
