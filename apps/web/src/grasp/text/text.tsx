// Text: running words from the type scale, built for Grasp. shadcn has none (it styles p, lead,
// large, small and muted in its typography page). One component with a size, a weight and an
// ink, so a product never sets a font size, a line height or a grey by hand.
//
//   <Text>Reports appear here once a review is closed.</Text>         15px body, in text
//   <Text size="lg">Everything the workspace is working on.</Text>    a lead under a title
//   <Text size="xs" tone="muted">Edited 12 November</Text>             a quiet note
//   <Text element="span" weight="medium">Amara Okafor</Text>         inside another line
//
// Geist, at the sizes and line heights of the tokens, in one of four inks. Every value is a token
// (src/tokens). A caller may set layout only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { grasp } from "../tokens/tokens.stylex";

type Layout = string | number | null;

/** What a caller may style: where the words sit and how wide they may run. Never their type. */
export type TextLayoutStyle = stylex.StyleXStyles<{
  alignSelf?: Layout;
  justifySelf?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  maxWidth?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginBlockStart?: Layout;
  marginBlockEnd?: Layout;
  marginInline?: Layout;
  textAlign?: Layout;
}>;

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
  /** An id, so `aria-describedby` can point at it. */
  id?: string;
  /** Layout only: margins, alignment and width. The type belongs to the words. */
  style?: TextLayoutStyle;
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
});

export const Text = ({
  children,
  size = "md",
  weight = "regular",
  tone = "text",
  element: Tag = "p",
  id,
  style,
}: TextProps) => (
  <Tag
    id={id}
    data-slot="text"
    {...stylex.props(
      styles.text,
      styles[size],
      styles[weight],
      tone === "text" ? styles.tone : styles[tone],
      style
    )}
  >
    {children}
  </Tag>
);
