import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
// The slash menu's keys and state: `/` at the start of a block or after a space opens a list of
// the kinds a block can be (the gutter's `+` list, its words), the letters after it filter the
// list, ↑ and ↓ move through it, Enter or Tab puts the kind in place of `/` and the letters, as one
// step in the history, and Escape leaves what was typed. The caret stays in the document all along:
// the list is named to a screen reader through the document's own aria-activedescendant.
import { Extension } from "@tiptap/react";
import type { Editor } from "@tiptap/react";

import { documentEditorWords } from "../words";
import type { DocumentEditorWords } from "../words";
import { blockKinds, fresh, turnStep, turnsInto } from "./commands";
import type { BlockKind } from "./commands";

/** Where the menu stands: the `/` and the caret, what is typed after it, and the chosen row. */
export interface SlashState {
  active: boolean;
  from: number;
  to: number;
  query: string;
  index: number;
  /** A `/` Escape was pressed after: it stays closed until a new one is typed. */
  dismissed: number | null;
}

const closed: SlashState = {
  active: false,
  from: 0,
  to: 0,
  query: "",
  index: 0,
  dismissed: null,
};

export const slashKey = new PluginKey<SlashState>("document-editor-slash");

/** The kinds whose name holds the letters typed, in the menu's own words. */
export const kindsFor = (
  words: DocumentEditorWords,
  query: string
): BlockKind[] => {
  const wanted = query.toLocaleLowerCase();
  return blockKinds.filter((kind) =>
    words.kinds[kind].toLocaleLowerCase().includes(wanted)
  );
};

/** An option's id: the list's id and the row. */
export const optionId = (listId: string, index: number) =>
  `${listId}-option-${String(index)}`;

/** `/` and the letters after it, just before an empty caret in a text block (not in code). */
const typed = (state: EditorState) => {
  const { selection } = state;
  const { $from } = selection;
  if (
    !selection.empty ||
    !$from.parent.isTextblock ||
    $from.parent.type.spec.code === true
  ) {
    return null;
  }
  const before = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    "￼"
  );
  const found = /(?:^|\s)\/(?<query>[^\s/￼]{0,24})$/u.exec(before);
  const query = found?.groups?.query;
  return query === undefined
    ? null
    : { from: $from.pos - query.length - 1, to: $from.pos, query };
};

const next = (
  tr: Transaction,
  last: SlashState,
  state: EditorState
): SlashState => {
  const meta: unknown = tr.getMeta(slashKey);
  const at = typed(state);
  // The `/` Escape closed, moved with the edits; it stays closed while it stands.
  const dismissed =
    last.dismissed === null ? null : tr.mapping.map(last.dismissed);
  if (at === null) {
    return closed;
  }
  if (typeof meta === "object" && meta !== null) {
    if (Reflect.get(meta, "dismiss") === true) {
      return { ...closed, dismissed: at.from };
    }
    const index: unknown = Reflect.get(meta, "index");
    if (typeof index === "number") {
      return { ...last, index };
    }
  }
  if (dismissed === at.from) {
    return { ...closed, dismissed };
  }
  return {
    active: true,
    ...at,
    index: at.query === last.query && last.active ? last.index : 0,
    dismissed: null,
  };
};

/** Puts a kind in place of `/` and its letters, as one step: an empty text block turns into it, any other gets it under. */
export const pickKind = (
  editor: Editor,
  range: { from: number; to: number },
  kind: BlockKind
) => {
  // The pick is its own step: one undo gives back `/` and the letters, as typed.
  editor.view.dispatch(closeHistory(editor.state.tr));
  const { doc } = editor.state;
  const at = doc.resolve(range.from);
  const { parent } = at;
  // Only `/` and its letters in the block: it turns into the kind.
  const emptied = parent.textContent.length === range.to - range.from;
  if (emptied && turnsInto(kind) && parent.type.name === "paragraph") {
    return turnStep(editor.chain().focus().deleteRange(range), kind).run();
  }
  // The top-level block it stands in, read before the letters go.
  const start = at.depth === 0 ? null : at.before(1);
  const block = start === null ? null : doc.nodeAt(start);
  if (start === null || block === null) {
    return false;
  }
  const empty = emptied && at.depth === 1 && block.type.name === "paragraph";
  const size = block.nodeSize - (range.to - range.from);
  const placed = empty ? start : start + size;
  // One transaction: the letters out, the new block in (in the emptied block's place, or under it).
  const tr: Transaction = editor.state.tr.delete(range.from, range.to);
  if (empty) {
    tr.replaceWith(
      start,
      start + size,
      editor.schema.nodeFromJSON(fresh(kind))
    );
  } else {
    tr.insert(placed, editor.schema.nodeFromJSON(fresh(kind)));
  }
  tr.setSelection(
    TextSelection.near(
      tr.doc.resolve(Math.min(placed + 1, tr.doc.content.size))
    )
  );
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
};

/** Hands the keys the host's words and the list's id, once the menu is drawn. */
export const tellSlashKeys = (
  editor: Editor,
  words: DocumentEditorWords,
  listId: string
) => {
  const kept = editor.storage.slashMenu;
  kept.words = words;
  kept.listId = listId;
};

/** What the slash menu keeps in the editor: its words (the host's, once mounted) and its list's id. */
export interface SlashStorage {
  words: DocumentEditorWords;
  listId: string;
}

declare module "@tiptap/core" {
  interface Storage {
    slashMenu: SlashStorage;
  }
}

export const SlashMenuKeys = Extension.create<
  Record<string, never>,
  SlashStorage
>({
  name: "slashMenu",
  addStorage() {
    return { words: documentEditorWords, listId: "" };
  },
  addProseMirrorPlugins() {
    const { editor, storage } = this;
    return [
      new Plugin<SlashState>({
        key: slashKey,
        state: {
          init: () => closed,
          apply: (tr, last, _old, state) => next(tr, last, state),
        },
        props: {
          handleKeyDown: (view, event) => {
            const state = slashKey.getState(view.state);
            if (state?.active !== true) {
              return false;
            }
            const kinds = kindsFor(storage.words, state.query);
            const dismiss = () => {
              view.dispatch(
                view.state.tr
                  .setMeta(slashKey, { dismiss: true })
                  .setMeta("addToHistory", false)
              );
              return true;
            };
            const move = (by: number) => {
              if (kinds.length > 0) {
                view.dispatch(
                  view.state.tr
                    .setMeta(slashKey, {
                      index: (state.index + by + kinds.length) % kinds.length,
                    })
                    .setMeta("addToHistory", false)
                );
              }
              return true;
            };
            const pick = () => {
              const kind = kinds[state.index];
              return kind === undefined
                ? dismiss()
                : pickKind(editor, state, kind);
            };
            const keys: Record<string, (() => boolean) | undefined> = {
              ArrowDown: () => move(1),
              ArrowUp: () => move(-1),
              Enter: pick,
              Tab: pick,
              Escape: dismiss,
            };
            const act = keys[event.key];
            return act === undefined ? false : act();
          },
          // The list, named on the document itself: the caret never leaves it.
          attributes: (state): Record<string, string> => {
            const slash = slashKey.getState(state);
            if (slash?.active !== true || storage.listId === "") {
              return {};
            }
            const found = kindsFor(storage.words, slash.query).length > 0;
            return {
              "aria-controls": storage.listId,
              "aria-autocomplete": "list",
              ...(found
                ? {
                    "aria-activedescendant": optionId(
                      storage.listId,
                      slash.index
                    ),
                  }
                : {}),
            };
          },
        },
      }),
    ];
  },
});
