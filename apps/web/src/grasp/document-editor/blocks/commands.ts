import * as stylex from "@stylexjs/stylex";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
// What a document's gutter does to one top-level block (the handle's menu and `+`), and the keys that
// do the same with the caret in it: move it up or down, duplicate it, delete it, turn it into
// another kind, put a new block under it, and mark it pending while Grasp writes it again. Every
// action is one step in the history.
import { Extension } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/react";

import { grasp } from "../../tokens/tokens.stylex";

/** A top-level block: where it starts, and the node. */
export interface TopBlock {
  pos: number;
  size: number;
  type: string;
}

/** The top-level block holding `at` (the caret's by default), or null in an empty document. */
export const topBlockAt = (
  state: EditorState,
  at: number = state.selection.from
): TopBlock | null => {
  const resolved = state.doc.resolve(
    Math.min(Math.max(at, 0), state.doc.content.size)
  );
  if (resolved.depth === 0) {
    const node = state.doc.nodeAt(at);
    return node === null
      ? null
      : { pos: at, size: node.nodeSize, type: node.type.name };
  }
  const pos = resolved.before(1);
  const node = state.doc.nodeAt(pos);
  return node === null
    ? null
    : { pos, size: node.nodeSize, type: node.type.name };
};

/** The block before or after a block, at the top level. */
const neighbour = (
  state: EditorState,
  block: TopBlock,
  way: "up" | "down"
): TopBlock | null => {
  if (way === "up") {
    return block.pos === 0 ? null : topBlockAt(state, block.pos - 1);
  }
  const after = block.pos + block.size;
  return after >= state.doc.content.size ? null : topBlockAt(state, after + 1);
};

/** Moves a block past its neighbour, the caret with it. */
export const moveBlock = (
  editor: Editor,
  block: TopBlock,
  way: "up" | "down"
) => {
  const { state } = editor;
  const other = neighbour(state, block, way);
  const node = state.doc.nodeAt(block.pos);
  if (other === null || node === null) {
    return false;
  }
  const tr = state.tr.delete(block.pos, block.pos + block.size);
  const target = way === "up" ? other.pos : other.pos + other.size - block.size;
  tr.insert(target, node);
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus(target + 1);
  return true;
};

/** Puts a copy of a block under it. */
export const duplicateBlock = (editor: Editor, block: TopBlock) => {
  const node = editor.state.doc.nodeAt(block.pos);
  if (node === null) {
    return false;
  }
  editor.view.dispatch(
    editor.state.tr
      .insert(block.pos + block.size, node.copy(node.content))
      .scrollIntoView()
  );
  editor.commands.focus(block.pos + block.size + 1);
  return true;
};

/** Takes a block out; the document keeps one empty paragraph at least. */
export const deleteBlock = (editor: Editor, block: TopBlock) => {
  const { state } = editor;
  const tr = state.tr.delete(block.pos, block.pos + block.size);
  const { paragraph } = state.schema.nodes;
  if (tr.doc.childCount === 0 && paragraph !== undefined) {
    tr.insert(0, paragraph.create());
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus(Math.min(block.pos + 1, editor.state.doc.content.size));
  return true;
};

/** The kinds a block turns into, and a new block can be. */
export const blockKinds = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "blockquote",
  "callout",
  "details",
  "table",
] as const;
export type BlockKind = (typeof blockKinds)[number];

/** The kinds a text block turns into with its words kept; the rest are put in as a new block. */
export const turnsInto = (kind: BlockKind) => kind !== "table";

type Chain = ReturnType<Editor["chain"]>;

/** Adds turning the caret's text block into a kind to a chain, its words kept. */
export const turnStep = (chain: Chain, kind: BlockKind): Chain => {
  const steps: Record<BlockKind, () => Chain> = {
    paragraph: () => chain.setParagraph(),
    heading: () => chain.setHeading({ level: 2 }),
    bulletList: () => chain.toggleBulletList(),
    orderedList: () => chain.toggleOrderedList(),
    blockquote: () => chain.toggleBlockquote(),
    callout: () => chain.wrapIn("callout", { tone: "note" }),
    details: () =>
      chain.setDetails().updateAttributes("details", { open: true }),
    table: () => chain,
  };
  return steps[kind]();
};

/** Turns a text block into another kind, its words kept. */
export const turnInto = (editor: Editor, block: TopBlock, kind: BlockKind) =>
  turnsInto(kind) && turnStep(editor.chain().focus(block.pos + 1), kind).run();

/** A new, empty block of a kind. */
export const fresh = (kind: BlockKind): JSONContent => {
  const paragraph: JSONContent = { type: "paragraph" };
  const cell = (head: boolean): JSONContent => ({
    type: head ? "tableHeader" : "tableCell",
    content: [paragraph],
  });
  const row = (head: boolean): JSONContent => ({
    type: "tableRow",
    content: [cell(head), cell(head), cell(head)],
  });
  const blocks: Record<BlockKind, JSONContent> = {
    paragraph,
    heading: { type: "heading", attrs: { level: 2 } },
    bulletList: {
      type: "bulletList",
      content: [{ type: "listItem", content: [paragraph] }],
    },
    orderedList: {
      type: "orderedList",
      content: [{ type: "listItem", content: [paragraph] }],
    },
    blockquote: { type: "blockquote", content: [paragraph] },
    callout: { type: "callout", attrs: { tone: "note" }, content: [paragraph] },
    details: {
      type: "details",
      attrs: { open: true },
      content: [
        { type: "detailsSummary" },
        { type: "detailsContent", content: [paragraph] },
      ],
    },
    table: { type: "table", content: [row(true), row(false), row(false)] },
  };
  return blocks[kind];
};

/** Puts a new block of a kind under a block, the caret in it. */
export const insertBelow = (
  editor: Editor,
  block: TopBlock | null,
  kind: BlockKind
) => {
  const at =
    block === null ? editor.state.doc.content.size : block.pos + block.size;
  return editor
    .chain()
    .insertContentAt(at, fresh(kind))
    .focus(at + 2)
    .run();
};

// ---- Pending: a block Grasp is writing again ----------------------------------------------------

const styles = stylex.create({
  pending: { opacity: grasp.dim, cursor: "progress" },
});

const pendingKey = new PluginKey<DecorationSet>("document-editor-pending");

/** Marks a block pending (or not), as a decoration: the block's own DOM is never touched. */
export const setPending = (
  editor: Editor,
  block: TopBlock,
  pending: boolean
) => {
  editor.view.dispatch(
    editor.state.tr
      .setMeta(pendingKey, { block, pending })
      .setMeta("addToHistory", false)
  );
};

const pendingPlugin = () =>
  new Plugin<DecorationSet>({
    key: pendingKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr: Transaction, set: DecorationSet) => {
        // oxlint-disable-next-line unicorn/no-array-method-this-argument -- DecorationSet.map(mapping, doc), not an array's map
        const mapped = set.map(tr.mapping, tr.doc);
        const meta: unknown = tr.getMeta(pendingKey);
        if (typeof meta !== "object" || meta === null) {
          return mapped;
        }
        const block: unknown = Reflect.get(meta, "block");
        const pending = Reflect.get(meta, "pending") === true;
        if (typeof block !== "object" || block === null) {
          return mapped;
        }
        const pos = Number(Reflect.get(block, "pos"));
        const size = Number(Reflect.get(block, "size"));
        // oxlint-disable-next-line unicorn/no-array-method-this-argument -- DecorationSet.find(from, to), not an array's find
        const without = mapped.remove(mapped.find(pos, pos + size));
        return pending
          ? without.add(tr.doc, [
              Decoration.node(pos, pos + size, {
                class: stylex.props(styles.pending).className ?? "",
                "aria-busy": "true",
              }),
            ])
          : without;
      },
    },
    props: {
      decorations: (state) => pendingKey.getState(state),
    },
  });

/** The keys, and the pending marks. `openMenu` opens the gutter's block menu for the caret's block. */
export const BlockCommands = Extension.create({
  name: "blockCommands",
  addProseMirrorPlugins() {
    return [pendingPlugin()];
  },
  addKeyboardShortcuts() {
    const on = (act: (block: TopBlock) => boolean) => () => {
      const block = topBlockAt(this.editor.state);
      return block !== null && act(block);
    };
    return {
      "Mod-Shift-ArrowUp": on((block) => moveBlock(this.editor, block, "up")),
      "Mod-Shift-ArrowDown": on((block) =>
        moveBlock(this.editor, block, "down")
      ),
      "Mod-Shift-d": on((block) => duplicateBlock(this.editor, block)),
      "Mod-Shift-Backspace": on((block) => deleteBlock(this.editor, block)),
      "Mod-/": () => {
        this.editor.view.dom.dispatchEvent(
          new CustomEvent("document-editor-block-menu", { bubbles: true })
        );
        return true;
      },
    };
  },
});
