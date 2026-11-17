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

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { arrive } from "../motion/arrive";
import { Skeleton } from "../skeleton/skeleton";
import { grasp } from "../tokens/tokens.stylex";

/** What a caller may style: where the header sits, and how wide it is. Never its look. */
export type SectionHeaderLayoutStyle = LayoutStyle;

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
  headingLevel?: 2 | 3 | 4;
  /** @deprecated Use `headingLevel`. */
  level?: 2 | 3 | 4;
  /**
   * `md` for a section of a page; `sm` for a dense one (a settings card): the title and the
   * sentence at text-sm, the sentence right under it.
   * @default "md"
   */
  size?: "md" | "sm";
  /** The heading's id: for a link to the section (`#usage`), and for its Section's name. */
  id?: string;
  /**
   * Placeholders where the title and the sentence will be, while they load.
   * @default false
   */
  loading?: boolean;
  /** @deprecated Use `layout`. */
  style?: SectionHeaderLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the header. */
  layout?: SectionHeaderLayoutStyle;
}

/** A Section card narrower than this puts the actions on their own line (its head is the container). */
const NARROW_CARD = "@container section-card-head (width < 30rem)";

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
  // Dense: the title and the sentence at text-sm, one 20px line each, no room between them.
  wordsSm: { rowGap: 0 },
  // A dense head with a title alone: the title on the actions' middle, not 12px above it.
  headerCentred: { alignItems: "center" },
  titleSm: { fontSize: grasp.textSm, lineHeight: grasp.textSmLine },
  descriptionSm: { fontSize: grasp.textSm, lineHeight: grasp.textSmLine },
  description: {
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.muted,
    textWrap: "pretty",
    overflowWrap: "break-word",
  },
  // Never past the header's edge: on a line of their own they may shrink to its width and wrap
  // (a search and Invite on a phone ran 60px past a card at 320). In a Section card narrower than
  // 30rem they take the line under the title, its full width: by the card's width, not the window's.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    flexShrink: 1,
    flexBasis: { default: "auto", [NARROW_CARD]: "100%" },
    minWidth: 0,
    maxWidth: "100%",
    // Above a Section card's drag handle, which lies over the header: they stay pressable.
    position: "relative",
    zIndex: 1,
  },
  // Never wider than their room.
  titleWait: { width: "100%", maxWidth: grasp.sectionTitleWait },
  // A description runs to its line's end: its placeholder does too.
  descriptionWait: { width: "100%" },
});

/** A small header with no description stands centred on its line. */
const centredOf = (size: SectionHeaderProps["size"], description: ReactNode) =>
  size === "sm" && description === undefined;

export const SectionHeader = ({
  title,
  description,
  aside,
  actions,
  level: levelDeprecated,
  headingLevel: level = levelDeprecated ?? 2,
  size = "md",
  id,
  loading = false,
  style: styleProp,
  layout,
}: SectionHeaderProps) => {
  const Heading = `h${level}` as const;
  // Words that replace the placeholder fade in; a header that never waited is simply there.
  // Remembered as state, set the first time it loads (React's way of keeping what a render saw).
  const [waited, setWaited] = useState(loading);
  if (loading && !waited) {
    setWaited(true);
  }
  const arrived = waited && !loading;
  const centred = centredOf(size, description);
  return (
    <div
      data-slot="section-header"
      aria-busy={loading || undefined}
      {...stylex.props(
        styles.header,
        centred && styles.headerCentred,
        layout ?? styleProp
      )}
    >
      <div {...stylex.props(styles.words, size === "sm" && styles.wordsSm)}>
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
              <Heading
                id={id}
                {...stylex.props(styles.title, size === "sm" && styles.titleSm)}
              >
                {title}
              </Heading>
              {aside}
            </div>
            {description !== undefined && (
              <p
                {...stylex.props(
                  styles.description,
                  size === "sm" && styles.descriptionSm,
                  arrived && arrive.in
                )}
              >
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
