// Heading: a title from the type scale.
// Its level is the outline (h1 to h4) and its size is the look, so a page never skips a
// level to get a smaller title, and never restyles one by hand.
//
//   <Heading level={1} size="lg">Reports</Heading>
//   <Heading level={2}>This quarter</Heading>             size follows the level by default
//   <Heading level={3} size="xs">Team members</Heading>   a component's own title, in the sans
//   <Heading level={4} size="2xs">Notifications</Heading> a section's title inside a page or panel
//
// Titles from `sm` up are the serif at 400, drawn closer; `xs` is the sans at 500, as a card's
// title, and `2xs` the same at the interface's own size. Every value is a token. A caller may set
// layout only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { colors, font, media } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";

/** A title's size on the type scale, from the largest: an opening title down to a section's. */
export type HeadingSize = "xl" | "lg" | "default" | "sm" | "xs" | "2xs";

/** Every prop a Heading takes. */
export interface HeadingProps {
  /** The words: what the page or section is, in a few words, in sentence case. */
  children: ReactNode;
  /** Its level in the page's outline, so levels never skip: h1 once per page. */
  level: 1 | 2 | 3 | 4;
  /**
   * The look: `xl` 44px, an opening title (32px on a phone); `lg` 32px, a page title; `default` 24px,
   * a section; `sm` 20px, a card or panel; `xs` 18px in the sans, a component's own title; `2xs`
   * 14px in the sans, a section's title inside a page or panel (the size of its words).
   * Defaults by level: 1 is `lg`, 2 is `default`, 3 is `sm`, 4 is `xs`.
   */
  size?: HeadingSize;
  /** An id, so a link or `aria-labelledby` can point at it. */
  id?: string;
  /** Layout only: margins, alignment and width. The type belongs to the heading. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  heading: {
    margin: 0,
    color: colors.foreground,
    // A long word breaks inside itself rather than run out of its box.
    overflowWrap: "break-word",
    textWrap: "balance",
  },
  serif: {
    fontFamily: font.serif,
    fontWeight: font.weightNormal,
    letterSpacing: font.trackingTitle,
  },
  xl: {
    fontSize: { default: font.headingXl, [media.maxSm]: font.headingLg },
    lineHeight: {
      default: font.headingXlLine,
      [media.maxSm]: font.headingLgLine,
    },
  },
  lg: { fontSize: font.headingLg, lineHeight: font.headingLgLine },
  default: { fontSize: font.headingMd, lineHeight: font.headingMdLine },
  sm: { fontSize: font.headingSm, lineHeight: font.headingSmLine },
  xs: {
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    fontSize: font.headingXs,
    lineHeight: font.headingXsLine,
    letterSpacing: font.trackingUiTitle,
  },
  // The interface's own size, so a title over a group of settings stands as tall as its words and
  // is told apart by weight: text-sm, at 500.
  "2xs": {
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    letterSpacing: font.trackingUi,
  },
});

const bySize: Record<HeadingProps["level"], HeadingSize> = {
  1: "lg",
  2: "default",
  3: "sm",
  4: "xs",
};

export const Heading = ({
  children,
  level,
  size = bySize[level],
  id,
  style,
}: HeadingProps) => {
  const Tag = `h${level}` as const;
  return (
    <Tag
      id={id}
      data-slot="heading"
      data-size={size}
      {...stylex.props(
        styles.heading,
        size !== "xs" && size !== "2xs" && styles.serif,
        size === "xl" && styles.xl,
        size === "lg" && styles.lg,
        size === "default" && styles.default,
        size === "sm" && styles.sm,
        size === "xs" && styles.xs,
        size === "2xs" && styles["2xs"],
        style
      )}
    >
      {children}
    </Tag>
  );
};
