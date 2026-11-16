// SectionHeader: the title of a part of a page, with a sentence under it and the part's actions at
// the end of the row, from Palermo's Section Header, made Grasp's: the title in the sans at text-lg
// medium, as a card's, the sentence muted. Anything that belongs beside the title (a badge) goes in
// `aside`. While the section loads, placeholders stand where the words will be.
//
//   <SectionHeader title="Usage" description="Seats and storage this month." actions={<Button>Export</Button>} />
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop). Words that
// replace the placeholders fade in (src/motion/arrive.ts).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { arrive } from "../motion/arrive";
import { Skeleton } from "../skeleton/skeleton";
import { grasp } from "../tokens/tokens.stylex";

type Layout = string | number | null;

/** What a caller may style: where the header sits, and how wide it is. Never its look. */
export type SectionHeaderLayoutStyle = stylex.StyleXStyles<{
  width?: Layout;
  maxWidth?: Layout;
  alignSelf?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginBlockStart?: Layout;
  marginBlockEnd?: Layout;
  marginInline?: Layout;
}>;

/** Every prop a SectionHeader takes. */
export interface SectionHeaderProps {
  /** The section's name, in sentence case ("Usage"). */
  title: ReactNode;
  /** One sentence under it: what the section holds. */
  description?: ReactNode;
  /** Beside the title: a badge that says it is new, a count. */
  aside?: ReactNode;
  /** At the end of the row: the section's own buttons. */
  actions?: ReactNode;
  /**
   * The heading's level, so the page's outline stays in order.
   * @default 2
   */
  level?: 2 | 3 | 4;
  /** The heading's id: for a link to the section (`#usage`), and for its Section's name. */
  id?: string;
  /**
   * Placeholders where the title and the sentence will be, while they load.
   * @default false
   */
  loading?: boolean;
  /** Layout only: margins and alignment. The look belongs to the header. */
  style?: SectionHeaderLayoutStyle;
}

const styles = stylex.create({
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    columnGap: grasp.space4,
    rowGap: grasp.space3,
    minWidth: 0,
  },
  words: {
    display: "grid",
    rowGap: grasp.space1,
    flexGrow: 1,
    flexBasis: "16rem",
    minWidth: 0,
  },
  titleRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  title: {
    margin: 0,
    minWidth: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textLg,
    lineHeight: grasp.textLgLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    textWrap: "balance",
    overflowWrap: "break-word",
    // A link to the section lands with room above it.
    scrollMarginTop: grasp.space6,
  },
  description: {
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.muted,
    textWrap: "pretty",
    overflowWrap: "break-word",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    flexShrink: 0,
  },
  // Never wider than their room.
  titleWait: { width: "100%", maxWidth: grasp.sectionTitleWait },
  // A description runs to its line's end: its placeholder does too.
  descriptionWait: { width: "100%" },
});

export const SectionHeader = ({
  title,
  description,
  aside,
  actions,
  level = 2,
  id,
  loading = false,
  style,
}: SectionHeaderProps) => {
  const Heading = `h${level}` as const;
  // Words that replace the placeholder fade in; a header that never waited is simply there.
  // Remembered as state, set the first time it loads (React's way of keeping what a render saw).
  const [waited, setWaited] = useState(loading);
  if (loading && !waited) {
    setWaited(true);
  }
  const arrived = waited && !loading;
  return (
    <div
      data-slot="section-header"
      aria-busy={loading || undefined}
      {...stylex.props(styles.header, style)}
    >
      <div {...stylex.props(styles.words)}>
        {loading ? (
          <>
            <Skeleton text="lg" layout={styles.titleWait} />
            {description !== undefined && (
              <Skeleton text="md" layout={styles.descriptionWait} />
            )}
          </>
        ) : (
          <>
            <div {...stylex.props(styles.titleRow, arrived && arrive.in)}>
              <Heading id={id} {...stylex.props(styles.title)}>
                {title}
              </Heading>
              {aside}
            </div>
            {description !== undefined && (
              <p {...stylex.props(styles.description, arrived && arrive.in)}>
                {description}
              </p>
            )}
          </>
        )}
      </div>
      {actions !== undefined && (
        <div {...stylex.props(styles.actions)}>{actions}</div>
      )}
    </div>
  );
};
