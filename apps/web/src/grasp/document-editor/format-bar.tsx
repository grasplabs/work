"use client";

import * as stylex from "@stylexjs/stylex";
import { posToDOMRect, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { position } from "@ui-sdk/core";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import {
  Bold,
  Code,
  FoldSection,
  HeadingText,
  Italic,
  Link,
  ListBulleted,
  ListNumbered,
  QuoteText,
} from "../icons";
import type { IconData } from "../icons";
import { Input } from "../input";
import { Toggle } from "../toggle";
import { editorStyles } from "./styles";
import type { DocumentEditorWords } from "./words";

/** What the bar needs to know of the editor, read again on each change. */
const read = ({ editor }: { editor: Editor }) => ({
  shown: editor.isEditable && !editor.state.selection.empty && editor.isFocused,
  from: editor.state.selection.from,
  to: editor.state.selection.to,
  bold: editor.isActive("bold"),
  italic: editor.isActive("italic"),
  code: editor.isActive("code"),
  link: editor.isActive("link"),
  heading: editor.isActive("heading"),
  ordered: editor.isActive("orderedList"),
  bullets: editor.isActive("bulletList"),
  quote: editor.isActive("blockquote"),
  details: editor.isActive("details"),
});

/** The selection, as an anchor UI SDK reads on every check, so the bar follows it. */
const selectionAnchor = (editor: Editor) => ({
  getBoundingClientRect: () => {
    const { from, to } = editor.state.selection;
    return posToDOMRect(editor.view, from, to);
  },
});

/** A ref's cleanup when it placed nothing. */
const holdNothing = () => {
  // Nothing was started.
};

/** Places the bar in the top layer against the selection, as a ref callback; stops when it leaves. */
const placeAgainst =
  (editor: Editor, keep: (place: (() => void) | null) => void) =>
  (bar: HTMLDivElement | null) => {
    if (bar === null) {
      return holdNothing;
    }
    if (!bar.matches(":popover-open")) {
      bar.showPopover();
    }
    const placed = position(selectionAnchor(editor), bar, {
      side: "top",
      align: "center",
      sideOffset: 8,
    });
    keep(() => {
      placed.place();
    });
    return () => {
      placed();
      keep(null);
    };
  };

const Mark = ({
  icon,
  label,
  pressed,
  onPress,
}: {
  icon: IconData;
  label: string;
  pressed: boolean;
  onPress: () => void;
}) => (
  <Toggle
    size="xs"
    icon={icon}
    aria-label={label}
    pressed={pressed}
    onPressedChange={onPress}
  />
);

/** The field a link's address is written in, in the bar's place. */
const LinkField = ({
  label,
  onDone,
}: {
  label: string;
  onDone: (href: string | null) => void;
}) => {
  const [href, setHref] = useState("");
  return (
    <Input
      size="sm"
      type="url"
      autoFocus
      aria-label={label}
      placeholder={label}
      value={href}
      onValueChange={(next: string) => {
        setHref(next);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onDone(href.trim() === "" ? null : href.trim());
        } else if (event.key === "Escape") {
          event.preventDefault();
          onDone(null);
        }
      }}
      layout={editorStyles.linkField}
    />
  );
};

export const FormatBar = ({
  editor,
  words,
}: {
  editor: Editor;
  words: DocumentEditorWords;
}) => {
  const state = useEditorState({ editor, selector: read });
  const [inside, setInside] = useState(false);
  const [linking, setLinking] = useState(false);
  const place = useRef<(() => void) | null>(null);
  const keep = (next: (() => void) | null) => {
    place.current = next;
  };
  // A new selection under an open bar: it moves to it.
  useEffect(() => {
    place.current?.();
  });
  if (!state.shown && !inside) {
    return null;
  }
  const run =
    (
      step: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>
    ) =>
    () => {
      step(editor.chain().focus()).run();
    };
  const body: ReactNode = linking ? (
    <LinkField
      label={words.linkAddress}
      onDone={(href) => {
        setLinking(false);
        setInside(false);
        const chain = editor.chain().focus();
        (href === null
          ? chain
          : chain.extendMarkRange("link").setLink({ href })
        ).run();
      }}
    />
  ) : (
    <>
      <Mark
        icon={Bold}
        label={words.bold}
        pressed={state.bold}
        onPress={run((chain) => chain.toggleBold())}
      />
      <Mark
        icon={Italic}
        label={words.italic}
        pressed={state.italic}
        onPress={run((chain) => chain.toggleItalic())}
      />
      <Mark
        icon={Code}
        label={words.code}
        pressed={state.code}
        onPress={run((chain) => chain.toggleCode())}
      />
      <Mark
        icon={Link}
        label={words.link}
        pressed={state.link}
        onPress={() => {
          if (state.link) {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
          } else {
            setLinking(true);
          }
        }}
      />
      <span aria-hidden="true" {...stylex.props(editorStyles.rule)} />
      <Mark
        icon={HeadingText}
        label={words.heading}
        pressed={state.heading}
        onPress={run((chain) => chain.toggleHeading({ level: 2 }))}
      />
      <Mark
        icon={ListNumbered}
        label={words.numberedList}
        pressed={state.ordered}
        onPress={run((chain) => chain.toggleOrderedList())}
      />
      <Mark
        icon={ListBulleted}
        label={words.bulletList}
        pressed={state.bullets}
        onPress={run((chain) => chain.toggleBulletList())}
      />
      <Mark
        icon={QuoteText}
        label={words.quote}
        pressed={state.quote}
        onPress={run((chain) => chain.toggleBlockquote())}
      />
      <Mark
        icon={FoldSection}
        label={words.collapsible}
        pressed={state.details}
        onPress={run((chain) =>
          state.details
            ? chain.unsetDetails()
            : chain.setDetails().updateAttributes("details", { open: true })
        )}
      />
    </>
  );
  return (
    <div
      ref={placeAgainst(editor, keep)}
      popover="manual"
      role="toolbar"
      tabIndex={-1}
      aria-label={words.formatBar}
      data-slot="document-editor-format-bar"
      onMouseDown={(event) => {
        // A press on the bar keeps the words selected and the focus in the document.
        if (!(event.target instanceof HTMLInputElement)) {
          event.preventDefault();
        }
      }}
      onFocus={() => {
        setInside(true);
      }}
      onBlur={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
        ) {
          setInside(false);
          setLinking(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setInside(false);
          setLinking(false);
          editor.commands.focus();
        }
      }}
      {...stylex.props(editorStyles.bar)}
    >
      {body}
    </div>
  );
};
