/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { textStyles as styles } from "./styles";

/** What a caller may style: where the words sit and how wide they may run. Never their type. */
export type TextLayoutStyle = LayoutStyle;

/** A size of running text, from the smallest there is to a lead. */
export type TextSize = "xs" | "sm" | "md" | "lg";
/** The ink of the words, from the strongest. */
export type TextTone = "ink" | "text" | "muted" | "quiet";

/** Every prop a Text takes. */
export interface TextProps {
  /** The words. */
  children: ReactNode;
  /**
   * `xs` 13px for notes, tags and labels; `sm` 14px for controls, menus and dense lists; `md`
   * 15px, body text; `lg` 17px, a lead under a page title. Each with its own line height.
   * @default "md"
   */
  size?: TextSize;
  /**
   * `regular` for running text; `medium` for a label or a name. Nothing heavier exists.
   * @default "regular"
   */
  weight?: "regular" | "medium";
  /**
   * `ink` for words that must be read first, `text` for body text, `muted` for what supports it,
   * `quiet` for the least: a timestamp, a count. Every ink holds 4.5:1 on paper, soft and raised.
   * @default "text"
   */
  tone?: TextTone;
  /**
   * The element: `p` for a paragraph, `span` inside another line, `div` for a block that holds
   * other blocks.
   * @default "p"
   */
  element?: "p" | "span" | "div";
  /**
   * How a line too long for its room breaks: `words` at a space, and inside a word only when it
   * alone is wider; `anywhere` at any letter, for an email or an id in a one-line row; `truncate`
   * one line cut with an ellipsis, the whole text still read by a screen reader and shown as the
   * pointer's tooltip when it is words.
   * @default "words"
   */
  wrap?: "words" | "anywhere" | "truncate";
  /**
   * `body`, Geist, as running text is. `display`, the serif (Geist Serif) at the same size and line,
   * with the title's tracking: one line that opens a card or a section, as a lead in the display
   * face ("Choose the AI that Grasp's chat, agents and workflows run on.").
   * @default "body"
   */
  variant?: "body" | "display";
  /** An id, so `aria-describedby` can point at it. */
  id?: string;
  /** @deprecated Use `layout`. */
  style?: TextLayoutStyle;
  /** Layout only: margins, alignment and width. The type belongs to the words. */
  layout?: TextLayoutStyle;
}

export const Text = ({
  children,
  size = "md",
  weight = "regular",
  tone = "text",
  element: Tag = "p",
  wrap = "words",
  variant = "body",
  id,
  style: styleProp,
  layout,
}: TextProps) => (
  <Tag
    id={id}
    data-slot="text"
    title={
      wrap === "truncate" && typeof children === "string" ? children : undefined
    }
    {...stylex.props(
      styles.text,
      styles[size],
      styles[weight],
      tone === "text" ? styles.tone : styles[tone],
      styles[wrap],
      variant === "display" && styles.display,
      layout ?? styleProp
    )}
  >
    {children}
  </Tag>
);
