// Heading: a title from the type scale, built for Grasp. shadcn has none (it styles h1 to h4 in
// its typography page). Its level is the outline (h1 to h4) and its size is the look, so a page
// never skips a level to get a smaller title, and never restyles one by hand.
//
//   <Heading level={1} size="lg">Reports</Heading>
//   <Heading level={2}>This quarter</Heading>             size follows the level by default
//   <Heading level={3} size="ui">Team members</Heading>   a component's own title, in the sans
//
// Titles from title-sm up are Geist Serif at 400, drawn closer (tracking-title); `ui` is the
// sans at 500, as a card's title. Every value is a token (src/tokens). A caller may set layout
// only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { grasp, media } from "../tokens/tokens.stylex";

type Layout = string | number | null;

/** What a caller may style: where the heading sits and how wide it may run. Never its type. */
export type HeadingLayoutStyle = stylex.StyleXStyles<{
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

/** A title's look, from the largest: an opening title down to a component's own. */
export type HeadingSize = "xl" | "lg" | "md" | "sm" | "ui";

/** Every prop a Heading takes. */
export interface HeadingProps {
  /** The words: what the page or section is, in a few words, in sentence case. */
  children: ReactNode;
  /** Its level in the page's outline, so levels never skip: h1 once per page. */
  level: 1 | 2 | 3 | 4;
  /**
   * The look: `xl` 44px, an opening title (32px on a phone); `lg` 32px, a page title; `md` 24px,
   * a section; `sm` 20px, a card or panel; `ui` 18px in the sans, a component's own title.
   * Defaults by level: 1 is `lg`, 2 is `md`, 3 is `sm`, 4 is `ui`.
   */
  size?: HeadingSize;
  /** An id, so a link or `aria-labelledby` can point at it. */
  id?: string;
  /** Layout only: margins, alignment and width. The type belongs to the heading. */
  style?: HeadingLayoutStyle;
}

const bySize: Record<HeadingProps["level"], HeadingSize> = {
  1: "lg",
  2: "md",
  3: "sm",
  4: "ui",
};

const styles = stylex.create({
  heading: {
    margin: 0,
    color: grasp.ink,
    // A long word breaks inside itself rather than run out of its box.
    overflowWrap: "break-word",
    textWrap: "balance",
  },
  serif: {
    fontFamily: grasp.fontSerif,
    fontWeight: grasp.weightRegular,
    letterSpacing: grasp.trackingTitle,
  },
  xl: {
    fontSize: { default: grasp.titleXl, [media.belowPhone]: grasp.titleLg },
    lineHeight: {
      default: grasp.titleXlLine,
      [media.belowPhone]: grasp.titleLgLine,
    },
  },
  lg: { fontSize: grasp.titleLg, lineHeight: grasp.titleLgLine },
  md: { fontSize: grasp.titleMd, lineHeight: grasp.titleMdLine },
  sm: { fontSize: grasp.titleSm, lineHeight: grasp.titleSmLine },
  ui: {
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    fontSize: grasp.titleUi,
    lineHeight: grasp.titleUiLine,
    letterSpacing: grasp.trackingUiTitle,
  },
});

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
        size !== "ui" && styles.serif,
        styles[size],
        style
      )}
    >
      {children}
    </Tag>
  );
};
