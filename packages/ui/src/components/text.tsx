// Text: running words from the type scale.
// One component with a size, a weight and a colour, so a product
// never sets a font size, a line height or a grey by hand.
//
//   <Text>Reports appear here once a review is closed.</Text>          15px body, secondary
//   <Text size="lg">Everything the workspace is working on.</Text>     a lead under a title
//   <Text size="xs" color="muted">Edited 12 November</Text>            a quiet note
//   <Text as="span" weight="medium">Amara Okafor</Text>                inside another line
//   <Text size="sm" truncate>anna.de.vries@example.com</Text>          one line, an ellipsis
//
// With `truncate`, the words stay on one line and end in an ellipsis when they do not fit; only
// then a Tooltip shows them whole, so words that fit carry no tooltip. Every value is a token. A
// caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { colors, font } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** A size of running text, from the smallest there is to a lead. */
export type TextSize = "xs" | "sm" | "default" | "lg";
/** The colour of the words, from the strongest. */
export type TextColor = "default" | "secondary" | "muted" | "subtle";

/** Every prop a Text takes. */
export interface TextProps {
  /** The words. */
  children: ReactNode;
  /**
   * `xs` 13px for notes, tags and labels; `sm` 14px for controls, menus and dense lists;
   * `default` 15px, body text; `lg` 17px, a lead under a page title. Each with its own line height.
   * @default "default"
   */
  size?: TextSize;
  /**
   * `normal` for running text; `medium` for a label or a name. Nothing heavier exists.
   * @default "normal"
   */
  weight?: "normal" | "medium";
  /**
   * `default` for words that must be read first, `secondary` for body text, `muted` for what
   * supports it, `subtle` for the least: a timestamp, a count. Each holds 4.5:1 on every ground.
   * @default "secondary"
   */
  color?: TextColor;
  /**
   * The element: `p` for a paragraph, `span` inside another line, `div` for a block that holds
   * other blocks.
   * @default "p"
   */
  as?: "p" | "span" | "div";
  /**
   * How a line too long for its room breaks: `wrap` at a space, and inside a word only when it
   * alone is wider; `anywhere` at any letter, for an email or an id in a box that sizes to what it
   * holds.
   * @default "wrap"
   */
  wrap?: "wrap" | "anywhere";
  /**
   * One line, cut with an ellipsis when it does not fit. A screen reader still reads it whole, and
   * while it is cut a tooltip shows it whole to the pointer.
   * @default false
   */
  truncate?: boolean;
  /**
   * `body`, the sans, as running text is. `display`, the serif at the same size and line, with the
   * title's tracking: one line that opens a card or a section.
   * @default "body"
   */
  variant?: "body" | "display";
  /** An id, so `aria-describedby` can point at it. */
  id?: string;
  /** Layout only: margins, alignment and width. The type belongs to the words. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  text: {
    margin: 0,
    fontFamily: font.sans,
    letterSpacing: font.trackingUi,
    overflowWrap: "break-word",
  },
  display: { fontFamily: font.serif, letterSpacing: font.trackingTitle },
  anywhere: { overflowWrap: "anywhere" },
  truncate: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
});

const sizeStyles = stylex.create({
  xs: { fontSize: font.textXs, lineHeight: font.textXsLine },
  sm: { fontSize: font.textSm, lineHeight: font.textSmLine },
  default: { fontSize: font.textBase, lineHeight: font.textBaseLine },
  lg: { fontSize: font.textLg, lineHeight: font.textLgLine },
});

const weightStyles = stylex.create({
  normal: { fontWeight: font.weightNormal },
  medium: { fontWeight: font.weightMedium },
});

const colorStyles = stylex.create({
  default: { color: colors.foreground },
  secondary: { color: colors.bodyForeground },
  muted: { color: colors.mutedForeground },
  subtle: { color: colors.subtleForeground },
});

/**
 * Whether the truncated words are cut now, kept up to date as the element changes size and as its
 * words change in a box that does not (a name renamed to a longer one). Measured only while
 * `truncate` is on, each time after a layout, so a look costs no layout of its own.
 */
const useCut = (element: HTMLElement | null, truncate: boolean) => {
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const sized = new ResizeObserver(() => {
      setCut(element !== null && element.scrollWidth > element.clientWidth);
    });
    // New words in a box of the same size: observed anew, the box is reported again after the
    // next layout, and measured then.
    const worded = new MutationObserver(() => {
      if (element !== null) {
        sized.unobserve(element);
        sized.observe(element);
      }
    });
    if (truncate && element !== null) {
      sized.observe(element);
      worded.observe(element, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
    return () => {
      sized.disconnect();
      worded.disconnect();
    };
  }, [element, truncate]);
  return truncate && cut;
};

export const Text = ({
  children,
  size = "default",
  weight = "normal",
  color = "secondary",
  as: Tag = "p",
  wrap = "wrap",
  truncate = false,
  variant = "body",
  id,
  style,
}: TextProps) => {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const cut = useCut(element, truncate);
  const words = (
    <Tag
      ref={setElement}
      id={id}
      data-slot="text"
      // The tooltip only repeats the words, so it does not describe them as well: a screen reader
      // would hear them twice.
      aria-describedby={truncate ? "" : undefined}
      {...stylex.props(
        styles.text,
        sizeStyles[size],
        weightStyles[weight],
        colorStyles[color],
        wrap === "anywhere" && styles.anywhere,
        truncate && styles.truncate,
        variant === "display" && styles.display,
        style
      )}
    >
      {children}
    </Tag>
  );
  if (!truncate) {
    return words;
  }
  // Truncated: the pointer reads the whole words in a tooltip, which opens only while they are cut.
  // The same tree either way, so the words are not drawn anew as they come to fit or stop fitting.
  return (
    <Tooltip disabled={!cut}>
      <TooltipTrigger asChild>{words}</TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
};
