// DocumentEditor: one flowing document (paragraphs, headings, numbered and bulleted lists, a quote,
// code, links and collapsible sections) written in place and kept as Markdown. Built on Tiptap
// (extensions.ts) in the library's prose look, the same as Markdown shows, so what you write reads as
// what is shown. Markdown shortcuts as you type (`# `, `1. `, `- `, `> `, `>>> `), a format bar over
// the selection (format-bar.tsx), and the agent's rewrite as a state the host drives: locked while
// Grasp writes, the text arriving as it streams, and one undo bringing the old text back.
//
//   <DocumentEditor value={instructions} onValueChange={setInstructions} header={<Button…>Configure with agent</Button>} />
//
// Every value is a token (src/tokens). A caller may set layout only (the `layout` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { announce } from "../announce/announce";
import { Button } from "../button";
import { Undo } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { Markdown } from "../markdown";
import { markdownStyles } from "../markdown/styles";
import { Shimmer } from "../shimmer";
import { useWords, withGiven } from "../words/words";
import { BlocksContext } from "./blocks/context";
import type { AskAgainRequest } from "./blocks/context";
import { BlockGutter } from "./blocks/gutter";
import { SlashMenu } from "./blocks/slash-menu";
import { WordsHolder, editorExtensions } from "./extensions";
import { FormatBar } from "./format-bar";
import { editorStyles } from "./styles";
import { documentEditorWords } from "./words";
import type { DocumentEditorWords } from "./words";

/** What a caller may style: where the editor sits and how wide it is. Never its look. */
export type DocumentEditorLayoutStyle = LayoutStyle;

export interface DocumentEditorProps {
  /** The document as Markdown, for an editor your code holds. Give `onValueChange` with it. */
  value?: string;
  /** The document as Markdown at first, when the editor holds its own. */
  defaultValue?: string;
  /** Runs with the whole document as Markdown after each change. */
  onValueChange?: (markdown: string) => void;
  /** Actions in the editor's header, at its end ("Configure with agent"). */
  header?: ReactNode;
  /** What the empty document says until the first word. @default words.placeholder */
  placeholder?: string;
  /** Shown and selectable, not written in. @default false */
  readOnly?: boolean;
  /** Out of use: shown at half strength, not focusable. Say why near it. @default false */
  disabled?: boolean;
  /**
   * Grasp is rewriting the document: it is locked and says so, and the `value` you pass as the new
   * text streams in is shown as it comes. When it turns false the whole rewrite is one undo step,
   * and an "Undo rewrite" button brings the old text back until the next edit.
   * @default false
   */
  rewriting?: boolean;
  /**
   * Runs when a person asks Grasp again for one part (an Ask block, or a section from its menu), with
   * its question and its Markdown now; resolve with the part's new Markdown. The part shows it is
   * pending until then and is written again as one step in the history, so undo brings the last
   * answer back. Leave it out and there is no Ask again.
   */
  onAskAgain?: (request: AskAgainRequest) => Promise<string>;
  /** The document's name, said to a screen reader ("Instructions"). @default words.label */
  "aria-label"?: string;
  /** The id of the words that name it (a field's label), instead of `aria-label`. */
  "aria-labelledby"?: string;
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key. Any left out are the
   * catalogue's, else English.
   */
  words?: Partial<DocumentEditorWords>;
  /**
   * `box`: an outlined surface, for a field in a form (an agent's instructions). `page`: no box, the
   * words on the page's own column, and a gutter beside each block (a `+` and a handle with its
   * menu) in the room before them: for a page people work in, as a Brain page.
   * @default "box"
   */
  variant?: "box" | "page";
  /** Where it sits and how wide it is. */
  layout?: DocumentEditorLayoutStyle;
}

/**
 * The document as Markdown: never more than one blank line between blocks (a table writes one of its
 * own on each side), outside fenced code, whose lines are kept as written; and without the empty
 * paragraph the editor keeps at its end.
 */
const written = (editor: Editor) =>
  editor
    .getMarkdown()
    .split(/(?<fence>^```[\s\S]*?^```$)/mu)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replaceAll(/\n{3,}/gu, "\n\n")
    )
    .join("")
    .trimEnd();

/** An effect's cleanup when it started nothing. */
const holdNothing = () => {
  // Nothing was started.
};

/** Replaces the document without a step in its history and without telling the host. */
const replaceQuietly = (
  editor: Editor,
  content: string | JSONContent,
  markdown: boolean
) => {
  editor
    .chain()
    .setMeta("addToHistory", false)
    .setContent(content, {
      emitUpdate: false,
      ...(markdown ? { contentType: "markdown" as const } : {}),
    })
    .run();
};

/**
 * Makes the rewrite one step in the history: the old document back without a step, then the new
 * one over it with one, so a single undo returns the old.
 */
const settleRewrite = (editor: Editor, before: JSONContent) => {
  const after = editor.getJSON();
  replaceQuietly(editor, before, false);
  editor.chain().setContent(after, { emitUpdate: false }).run();
};

/** The rewrite's start and end, as the host turns `rewriting` on and off. */
const useRewrite = (
  editor: Editor | null,
  rewriting: boolean,
  said: WordsHolder
) => {
  const before = useRef<JSONContent | null>(null);
  const [undoable, setUndoable] = useState(false);
  useEffect(() => {
    if (editor === null) {
      return;
    }
    if (rewriting) {
      before.current = editor.getJSON();
      announce(said.get().rewriting);
      return;
    }
    const was = before.current;
    if (was !== null) {
      before.current = null;
      settleRewrite(editor, was);
      announce(said.get().rewritten);
      setUndoable(true);
    }
  }, [editor, rewriting, said]);
  // The next edit makes the rewrite part of the document: the button leaves.
  useEffect(() => {
    if (editor === null || !undoable) {
      return holdNothing;
    }
    const leave = () => {
      setUndoable(false);
    };
    editor.on("update", leave);
    return () => {
      editor.off("update", leave);
    };
  }, [editor, undoable]);
  const undo = () => {
    editor?.chain().focus().undo().run();
    setUndoable(false);
  };
  return { undoable, undo };
};

/** Follows the host's `value`: a document changed outside (a reset, the rewrite's stream) is shown. */
const useFollowValue = (editor: Editor | null, value: string | undefined) => {
  useEffect(() => {
    if (
      editor === null ||
      value === undefined ||
      written(editor) === value.trimEnd()
    ) {
      return;
    }
    replaceQuietly(editor, value, true);
  }, [editor, value]);
};

/** The header: what Grasp is doing, the rewrite's undo, then the host's actions. */
const Header = ({
  header,
  rewriting,
  undoable,
  onUndo,
  words,
}: {
  header: ReactNode;
  rewriting: boolean;
  undoable: boolean;
  onUndo: () => void;
  words: DocumentEditorWords;
}) => {
  if (header === undefined && !rewriting && !undoable) {
    return null;
  }
  let status: ReactNode = null;
  if (rewriting) {
    status = <Shimmer>{words.rewriting}</Shimmer>;
  } else if (undoable) {
    status = (
      <>
        <span>{words.rewritten}</span>
        <Button variant="ghost" size="xs" icon={Undo} onClick={onUndo}>
          {words.undoRewrite}
        </Button>
      </>
    );
  }
  return (
    <div
      data-slot="document-editor-header"
      {...stylex.props(editorStyles.header)}
    >
      <div aria-live="off" {...stylex.props(editorStyles.status)}>
        {status}
      </div>
      {header === undefined ? null : (
        <div {...stylex.props(editorStyles.actions)}>{header}</div>
      )}
    </div>
  );
};

/**
 * The document before the editor mounts (on the server and until the editor's first draw): the same
 * Markdown, drawn read only by Markdown in the same look, so the page's first paint holds the text
 * and the swap to the editor moves nothing. No caret until the editor stands.
 */
const StillDocument = ({
  markdown,
  placeholder,
  page,
}: {
  markdown: string;
  placeholder: string;
  page: boolean;
}) => (
  <div
    data-slot="document-editor-still"
    {...stylex.props(
      editorStyles.document,
      page && editorStyles.pageDocument,
      editorStyles.still
    )}
  >
    {markdown.trim() === "" ? (
      <p
        {...stylex.props(
          markdownStyles.paragraph,
          editorStyles.stillPlaceholder
        )}
      >
        {placeholder}
      </p>
    ) : (
      <Markdown source={markdown} />
    )}
  </div>
);

/** What opens over the document: the format bar over a selection, and the slash menu under `/`. */
const Popups = ({
  editor,
  words,
}: {
  editor: Editor;
  words: DocumentEditorWords;
}) => (
  <>
    <FormatBar editor={editor} words={words} />
    {editor.isEditable ? <SlashMenu editor={editor} words={words} /> : null}
  </>
);

export const DocumentEditor = ({
  value,
  defaultValue,
  onValueChange,
  header,
  placeholder,
  readOnly = false,
  disabled = false,
  rewriting = false,
  onAskAgain,
  variant = "box",
  "aria-label": labelGiven,
  "aria-labelledby": labelledBy,
  words: ownWords,
  layout,
}: DocumentEditorProps) => {
  const words = withGiven(
    useWords("documentEditor", documentEditorWords, ownWords),
    { placeholder, label: labelGiven }
  );
  // The extensions read the words through this, so a change of language needs no new editor.
  // oxlint-disable-next-line react/hook-use-state -- made once, never replaced
  const [said] = useState(() => new WordsHolder(words));
  useEffect(() => {
    said.set(words);
  });
  // oxlint-disable-next-line react/hook-use-state -- made once, never replaced
  const [extensions] = useState(() => editorExtensions(said));
  const editable = !readOnly && !disabled && !rewriting;
  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: value ?? defaultValue ?? "",
    contentType: "markdown",
    editable,
    onUpdate: ({ editor: changed }) => {
      onValueChange?.(written(changed));
    },
  });
  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);
  // The document's own attributes: a multi-line text box, named, read only when it cannot be written.
  const documentClass = stylex.props(
    markdownStyles.root,
    editorStyles.document,
    variant === "page" && editorStyles.pageDocument,
    rewriting && editorStyles.rewriting
  ).className;
  useEffect(() => {
    editor?.setOptions({
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          ...(labelledBy === undefined
            ? { "aria-label": words.label }
            : { "aria-labelledby": labelledBy }),
          ...(editable ? {} : { "aria-readonly": "true" }),
          ...(disabled ? { "aria-disabled": "true" } : {}),
          ...(rewriting ? { "aria-busy": "true" } : {}),
          "data-slot": "document-editor-document",
          class: documentClass ?? "",
        },
      },
    });
  }, [
    editor,
    editable,
    disabled,
    rewriting,
    labelledBy,
    words.label,
    documentClass,
  ]);
  // The rewrite first: it keeps the old document before the first streamed words replace it.
  const { undoable, undo } = useRewrite(editor, rewriting, said);
  useFollowValue(editor, value);
  return (
    <div
      data-slot="document-editor"
      data-rewriting={rewriting || undefined}
      {...stylex.props(
        editorStyles.frame,
        variant === "page" && editorStyles.page,
        disabled && editorStyles.disabled,
        layout
      )}
    >
      <Header
        header={header}
        rewriting={rewriting}
        undoable={undoable}
        onUndo={undo}
        words={words}
      />
      {/* Before the document, so Shift+Tab from it reaches the gutter (Mod+/ opens its menu at once). */}
      {editor === null || variant !== "page" ? null : (
        <BlockGutter editor={editor} words={words} askAgain={onAskAgain} />
      )}
      {editor === null ? (
        <StillDocument
          markdown={value ?? defaultValue ?? ""}
          placeholder={words.placeholder}
          page={variant === "page"}
        />
      ) : (
        <BlocksContext value={{ words, askAgain: onAskAgain }}>
          <EditorContent editor={editor} />
        </BlocksContext>
      )}
      {editor === null ? null : <Popups editor={editor} words={words} />}
    </div>
  );
};
