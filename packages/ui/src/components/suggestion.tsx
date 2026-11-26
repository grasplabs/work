// Suggestion: prompts a person can send with one press, in a row that scrolls sideways,
// built on Button. The
// row never wraps: what does not fit runs past its end and scrolls, by wheel, touch, keys and focus,
// with no bar, and the side with more beyond it fades out.
//
//   <Suggestions>
//     <Suggestion suggestion="Summarise this thread" onClick={send} />
//     <Suggestion suggestion="Draft a reply" onClick={send} />
//   </Suggestions>
//
// The row is a group named Suggestions; each suggestion is an outline Button named by its words,
// which hands them to `onClick`. Tab walks the buttons and the row scrolls each wholly into view,
// clear of the fade, as it takes focus. The row leaves room round the buttons for the keyboard's
// ring, so the scroller never clips it, and stands out by as much so the buttons keep the column's
// edge. Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { useScrollEdges } from "../hooks/use-scroll-edges";
import { useI18n } from "../lib/i18n";
import { edgeFade, scrollbarHidden } from "../lib/styles";
import { media, size, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { Button } from "./button";
import type { ButtonVariant } from "./button";

/** Every prop Suggestions takes. */
export interface SuggestionsProps {
  /** Its Suggestion buttons, in the order they are offered. */
  children: ReactNode;
  /**
   * Its name, for a screen reader: what the suggestions are for.
   * @default "Suggestions"
   */
  "aria-label"?: string;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a Suggestion takes. */
export interface SuggestionProps {
  /** The prompt it offers ("Summarise this thread"): its words, and what `onClick` is handed. */
  suggestion: string;
  /** Runs with `suggestion` when it is pressed: send it as is, or put it in the prompt. */
  onClick?: (suggestion: string) => void;
  /** What it shows in place of `suggestion`'s words: shorter words, or an `<Icon />` and words. */
  children?: ReactNode;
  /**
   * The button's weight: `outline`, a quiet chip in a row under the conversation.
   * @default "outline"
   */
  variant?: ButtonVariant;
  /**
   * The button's height: `xs` 28px, `sm` 32px, `default` 36px, `lg` 44px.
   * @default "sm"
   */
  size?: "xs" | "sm" | "default" | "lg";
  /**
   * Out of use: no press. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * Where it sits and how much room it takes. It lands on the suggestion's outermost element, the
   * box that holds it to the row's width; the button fills that box.
   */
  style?: LayoutStyle;
}

// The room the keyboard's ring takes round a button: kept inside the scroller so it is never cut.
const RING_ROOM = `calc(${size.ringWidth} + ${size.ringOffset})`;
// Above and below, on a touch screen, the room a finger's 44px target takes round the smallest
// button too, so the scroller never cuts it.
const BLOCK_ROOM = {
  default: RING_ROOM,
  [media.pointerCoarse]: `max(${RING_ROOM}, calc((${size.tapTarget} - ${size.controlXs}) / 2))`,
};

const styles = stylex.create({
  // The scroller, with the suggestions in one line: sideways only, no bar, and the sideways wheel
  // stays in it. It stands out by the ring's room on every side (and a finger's target's above and
  // below), so the buttons inside keep the column's edges.
  scroller: {
    display: "flex",
    flexWrap: "nowrap",
    alignItems: "center",
    gap: space["2"],
    boxSizing: "border-box",
    minWidth: 0,
    maxWidth: `calc(100% + 2 * ${RING_ROOM})`,
    marginInline: `calc(-1 * ${RING_ROOM})`,
    marginBlock: {
      default: `calc(-1 * ${RING_ROOM})`,
      [media.pointerCoarse]: `calc(-1 * ${BLOCK_ROOM[media.pointerCoarse]})`,
    },
    paddingInline: RING_ROOM,
    paddingBlock: BLOCK_ROOM,
    overflowX: "auto",
    overflowY: "hidden",
    overscrollBehaviorX: "contain",
  },
  // A suggestion's room in the row: as wide as its words, so the row scrolls before one shrinks, and
  // never wider than the row, so one longer than all of it is cut (Button's `truncate`).
  // One column the button fills, so a width given by `style` is the button's too.
  suggestion: {
    display: "inline-grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    flexShrink: 0,
    minWidth: 0,
    maxWidth: "100%",
  },
});

/** A row of suggested prompts that scrolls sideways. */
export const Suggestions = ({
  children,
  "aria-label": label,
  style,
}: SuggestionsProps) => {
  const words = useI18n().suggestion;
  // The sides with suggestions beyond them are marked for the fade there.
  const edges = useScrollEdges();
  return (
    <div
      ref={edges}
      role="group"
      aria-label={label ?? words.name}
      data-slot="suggestions"
      {...stylex.props(styles.scroller, scrollbarHidden, edgeFade, style)}
    >
      {children}
    </div>
  );
};

/** One suggested prompt: an outline Button that hands its words to `onClick`. */
export const Suggestion = ({
  suggestion,
  onClick,
  children,
  variant = "outline",
  size: height = "sm",
  disabled = false,
  style,
}: SuggestionProps) => (
  <span {...stylex.props(styles.suggestion, style)}>
    <Button
      type="button"
      variant={variant}
      size={height}
      // Never wider than the row: one too long for it is cut with an ellipsis, and keeps its name.
      truncate
      disabled={disabled}
      onClick={() => {
        onClick?.(suggestion);
      }}
      // A browser scrolls a button that takes focus only when none of it shows: one cut by the row's
      // edge, or under its fade, is brought wholly into view here, its ring with it.
      onFocus={(event) => {
        event.currentTarget.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
      }}
    >
      {children ?? suggestion}
    </Button>
  </span>
);
