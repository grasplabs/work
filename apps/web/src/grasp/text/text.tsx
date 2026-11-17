import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp } from "../tokens/tokens.stylex";

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
  /** An id, so `aria-describedby` can point at it. */
  id?: string;
  /** Layout only: margins, alignment and width. The type belongs to the words. */
  style?: TextLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: TextLayoutStyle;
}

const styles = stylex.create({
  text: {
    margin: 0,
    fontFamily: grasp.fontSans,
    letterSpacing: grasp.trackingUi,
    overflowWrap: "break-word",
  },
  xs: { fontSize: grasp.textXs, lineHeight: grasp.textXsLine },
  sm: { fontSize: grasp.textSm, lineHeight: grasp.textSmLine },
  md: { fontSize: grasp.textMd, lineHeight: grasp.textMdLine },
  lg: { fontSize: grasp.textLg, lineHeight: grasp.textLgLine },
  regular: { fontWeight: grasp.weightRegular },
  medium: { fontWeight: grasp.weightMedium },
  ink: { color: grasp.ink },
  tone: { color: grasp.text },
  muted: { color: grasp.muted },
  quiet: { color: grasp.quiet },
  // How a long line breaks; `words` is the text's own.
  words: {},
  anywhere: { overflowWrap: "anywhere" },
  truncate: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
});

export const Text = ({
  children,
  size = "md",
  weight = "regular",
  tone = "text",
  element: Tag = "p",
  wrap = "words",
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
      layout ?? styleProp
    )}
  >
    {children}
  </Tag>
);
