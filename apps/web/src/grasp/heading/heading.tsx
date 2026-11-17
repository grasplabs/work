// Heading: a title from the type scale, built for Grasp. shadcn has none (it styles h1 to h4 in
// its typography page). Its level is the outline (h1 to h4) and its size is the look, so a page
// never skips a level to get a smaller title, and never restyles one by hand.
//
//   <Heading level={1} size="lg">Reports</Heading>
//   <Heading level={2}>This quarter</Heading>             size follows the level by default
//   <Heading level={3} size="ui">Team members</Heading>   a component's own title, in the sans
//   <Heading level={4} size="ui-sm">Notifications</Heading>  a section title inside a page or panel
//
// Titles from title-sm up are Geist Serif at 400, drawn closer (tracking-title); `ui` is the
// sans at 500, as a card's title, and `ui-sm` the same at the interface's own size (text-sm). Every value is a token (src/tokens). A caller may set layout
// only (the `style` prop).
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";

/** What a caller may style: where the heading sits and how wide it may run. Never its type. */
export type HeadingLayoutStyle = LayoutStyle;

/** A title's look, from the largest: an opening title down to a component's own. */
export type HeadingSize = "xl" | "lg" | "md" | "sm" | "ui" | "ui-sm";

/** Every prop a Heading takes. */
export interface HeadingProps {
  /** The words: what the page or section is, in a few words, in sentence case. */
  children: ReactNode;
  /** Its level in the page's outline, so levels never skip: h1 once per page. */
  level: 1 | 2 | 3 | 4;
  /**
   * The look: `xl` 44px, an opening title (32px on a phone); `lg` 32px, a page title; `md` 24px,
   * a section; `sm` 20px, a card or panel; `ui` 18px in the sans, a component's own title;
   * `ui-sm` 14px in the sans, a section's title inside a page or panel (the size of its words).
   * Defaults by level: 1 is `lg`, 2 is `md`, 3 is `sm`, 4 is `ui`.
   */
  size?: HeadingSize;
  /** An id, so a link or `aria-labelledby` can point at it. */
  id?: string;
  /** @deprecated Use `layout`. */
  style?: HeadingLayoutStyle;
  /** Layout only: margins, alignment and width. The type belongs to the heading. */
  layout?: HeadingLayoutStyle;
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
  // The interface's own size, so a title over a group of settings stands as tall as its words and
  // is told apart by weight: text-sm, at 500.
  "ui-sm": {
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    letterSpacing: grasp.trackingUi,
  },
});

export const Heading = ({
  children,
  level,
  size = bySize[level],
  id,
  style: styleProp,
  layout,
}: HeadingProps) => {
  const Tag = `h${level}` as const;
  return (
    <Tag
      id={id}
      data-slot="heading"
      data-size={size}
      {...stylex.props(
        styles.heading,
        size !== "ui" && size !== "ui-sm" && styles.serif,
        styles[size],
        layout ?? styleProp
      )}
    >
      {children}
    </Tag>
  );
};
