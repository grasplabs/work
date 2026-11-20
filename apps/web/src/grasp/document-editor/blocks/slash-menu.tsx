"use client";

import * as stylex from "@stylexjs/stylex";
import { posToDOMRect, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { position } from "@ui-sdk/core";
import { useEffect, useId } from "react";

import { announce } from "../../announce/announce";
import { Icon } from "../../icons";
import { simply } from "../../motion/simply.stylex";
import { grasp, media } from "../../tokens/tokens.stylex";
import type { DocumentEditorWords } from "../words";
import { kindIcons } from "./kinds";
import { kindsFor, optionId, pickKind, slashKey, tellSlashKeys } from "./slash";

const grow = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.96)" },
  to: { opacity: 1, transform: "none" },
});

const ROW_CORNER = `min(calc(${grasp.corner} - ${grasp.popupPadding}), calc(${grasp.controlMd} / 2))`;

const styles = stylex.create({
  menu: {
    position: "fixed",
    inset: "auto",
    margin: 0,
    boxSizing: "border-box",
    width: "15rem",
    maxHeight: "min(24rem, 50dvh)",
    overflowY: "auto",
    padding: grasp.popupPadding,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.popupLift,
    color: grasp.ink,
    transformOrigin: "var(--transform-origin)",
    animationName: { default: grow, [media.reduced]: "none" },
    animationDuration: simply.ui,
    animationTimingFunction: grasp.ease,
  },
  label: {
    display: "flex",
    alignItems: "center",
    minHeight: grasp.controlSm,
    paddingInline: grasp.menuItemPadding,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: { default: grasp.muted, [media.forced]: "CanvasText" },
    userSelect: "none",
  },
  list: { margin: 0, padding: 0, listStyleType: "none" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: { default: null, [media.coarse]: grasp.tap },
    boxSizing: "border-box",
    padding: grasp.menuItemPadding,
    borderRadius: ROW_CORNER,
    cornerShape: grasp.cornerShape,
    fontWeight: grasp.weightMedium,
    cursor: "pointer",
    userSelect: "none",
  },
  chosen: {
    backgroundColor: {
      default: grasp.itemFillHighlight,
      [media.forced]: "Highlight",
    },
    color: { default: grasp.ink, [media.forced]: "HighlightText" },
  },
  icon: { display: "inline-flex", flexShrink: 0, color: grasp.muted },
  none: {
    margin: 0,
    padding: grasp.menuItemPadding,
    color: grasp.muted,
  },
});

/** A press on the menu keeps the caret in the document. */
const hold = (event: MouseEvent) => {
  event.preventDefault();
};

/** A ref's cleanup when it placed nothing. */
const holdNothing = () => {
  // Nothing was started.
};

/** Opens the menu in the top layer under the `/`, as a ref callback; stops placing it when it goes. */
const placeUnder =
  (editor: Editor, from: number) => (menu: HTMLDivElement | null) => {
    if (menu === null) {
      return holdNothing;
    }
    if (!menu.matches(":popover-open")) {
      menu.showPopover();
    }
    menu.addEventListener("mousedown", hold);
    const anchor = {
      getBoundingClientRect: () => posToDOMRect(editor.view, from, from),
    };
    const placed = position(anchor, menu, {
      side: "bottom",
      align: "start",
      sideOffset: 6,
    });
    return () => {
      placed();
      menu.removeEventListener("mousedown", hold);
    };
  };

const read = ({ editor }: { editor: Editor }) => {
  const slash = slashKey.getState(editor.state);
  return {
    active: slash?.active === true && editor.isFocused,
    from: slash?.from ?? 0,
    to: slash?.to ?? 0,
    query: slash?.query ?? "",
    index: slash?.index ?? 0,
  };
};

export const SlashMenu = ({
  editor,
  words,
}: {
  editor: Editor;
  words: DocumentEditorWords;
}) => {
  const state = useEditorState({ editor, selector: read });
  const listId = useId();
  const kinds = kindsFor(words, state.query);
  // The keys read the host's words and name the list on the document.
  useEffect(() => {
    tellSlashKeys(editor, words, listId);
  }, [editor, words, listId]);
  // How many rows the letters leave, said as they change.
  useEffect(() => {
    if (state.active) {
      announce(
        kinds.length > 0
          ? words.blocksFound(kinds.length)
          : words.noBlock(state.query)
      );
    }
  }, [state.active, state.query, kinds.length, words]);
  // The chosen row stays in sight in a short window.
  useEffect(() => {
    if (state.active) {
      document
        .querySelector(`#${CSS.escape(optionId(listId, state.index))}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [state.active, state.index, listId]);
  if (!state.active) {
    return null;
  }
  return (
    <div
      ref={placeUnder(editor, state.from)}
      popover="manual"
      data-slot="document-editor-slash-menu"
      {...stylex.props(styles.menu)}
    >
      <div id={`${listId}-label`} {...stylex.props(styles.label)}>
        {words.insert}
      </div>
      {kinds.length === 0 ? (
        <p {...stylex.props(styles.none)}>{words.noBlock(state.query)}</p>
      ) : (
        <ul
          id={listId}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- the document's popup list: focus stays in the document, and an <option> lives only in a <select>
          role="listbox"
          aria-labelledby={`${listId}-label`}
          {...stylex.props(styles.list)}
        >
          {kinds.map((kind, index) => (
            // The keys live in the document, which names the chosen row (aria-activedescendant).
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
            <li
              key={kind}
              id={optionId(listId, index)}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- as above
              role="option"
              aria-selected={index === state.index}
              onClick={() => {
                pickKind(editor, state, kind);
              }}
              {...stylex.props(
                styles.row,
                index === state.index && styles.chosen
              )}
            >
              <span aria-hidden="true" {...stylex.props(styles.icon)}>
                <Icon icon={kindIcons[kind]} />
              </span>
              {words.kinds[kind]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
