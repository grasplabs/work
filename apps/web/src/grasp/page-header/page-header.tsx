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
export type PageHeaderLayoutStyle = LayoutStyle;

/** Every prop a PageHeader takes. */
export interface PageHeaderProps {
  /** The page's name, in sentence case ("Spring launch"). It is the page's h1. */
  title: ReactNode;
  /** One line under the title: what the page holds. */
  description?: ReactNode;
  /**
   * How many lines the description may take before it is cut short with an ellipsis: 1 or 2 for one
   * someone wrote, which may run long. Cut short, a text description is whole in its title (a
   * pointer's tooltip) and to a screen reader, which reads the whole text.
   * @default "all"
   */
  descriptionLines?: 1 | 2 | "all";
  /**
   * While `loading`: how many lines the description's placeholder reserves, when you know the
   * description wraps (a phone, a long line), so nothing moves when it arrives. Without it, the
   * clamp you set with `descriptionLines`, or one line.
   */
  loadingLines?: number;
  /** Above the title: where the page sits, a Breadcrumb, for a page without an App shell (whose page bar holds the crumbs). */
  breadcrumb?: ReactNode;
  /** Beside the title: a badge that says its status. */
  aside?: ReactNode;
  /** At the end of the title row: the page's own buttons, the main one last. */
  actions?: ReactNode;
  /**
   * `lg` for a page of its own: the serif title-lg with a lead. `md` for a settings page: the serif
   * at title-md, a sentence (if any) at text-sm, as dense as `sm`. `sm` for a sub-page whose crumbs
   * already say where you are: the title at title-sm in the sans, and a sentence, if any, at text-sm.
   * Leave the lead out on `md` and `sm`.
   * @default "lg"
   */
  size?: "lg" | "md" | "sm";
  /** Under the title: the page's Tabs, when it has views. */
  tabs?: ReactNode;
  /**
   * Placeholders where the title and the line will be, while the page loads.
   * @default false
   */
  loading?: boolean;
  /** @deprecated Use `layout`. */
  style?: PageHeaderLayoutStyle;
  /** Layout only: margins and width. The look belongs to the header. */
  layout?: PageHeaderLayoutStyle;
}

const styles = stylex.create({
  header: {
    display: "grid",
    rowGap: grasp.space3,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  // As Palermo's section header: the actions stand 16px from the words, level with their last line.
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    columnGap: grasp.space4,
    rowGap: grasp.space4,
    minWidth: 0,
  },
  words: {
    display: "grid",
    rowGap: grasp.space1,
    flexGrow: 1,
    flexBasis: "20rem",
    minWidth: 0,
  },
  titleRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
    minWidth: 0,
  },
  title: {
    margin: 0,
    minWidth: 0,
    fontFamily: grasp.fontSerif,
    fontSize: grasp.titleLg,
    lineHeight: grasp.titleLgLine,
    fontWeight: grasp.weightRegular,
    letterSpacing: grasp.trackingTitle,
    color: grasp.ink,
    textWrap: "balance",
    overflowWrap: "break-word",
  },
  description: {
    margin: 0,
    fontSize: grasp.textLg,
    lineHeight: grasp.textLgLine,
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
    minHeight: grasp.titleLgLine,
  },
  tabs: {
    minWidth: 0,
    marginTop: grasp.space3,
  },
  // Never wider than its room: a phone is narrower than a title is long.
  // As tall as the title's letters, in the middle of its line, as a text placeholder is: the line
  // keeps its room, so nothing moves when the title arrives.
  titleWait: {
    width: "100%",
    maxWidth: grasp.pageTitleWait,
    height: grasp.titleLg,
    marginBlock: `calc((${grasp.titleLgLine} - ${grasp.titleLg}) / 2)`,
  },
  // A sub-page's title: a step down, in the sans, as a component's own title; its line, and the
  // actions' and the placeholder's, follow it.
  titleSm: {
    fontFamily: grasp.fontSans,
    fontSize: grasp.titleSm,
    lineHeight: grasp.titleSmLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.trackingUiTitle,
  },
  descriptionSm: { fontSize: grasp.textSm, lineHeight: grasp.textSmLine },
  // A settings page's title: the page's serif at the middle size, as dense as a sub-page's.
  titleMd: { fontSize: grasp.titleMd, lineHeight: grasp.titleMdLine },
  actionsMd: { minHeight: grasp.titleMdLine },
  titleWaitMd: {
    height: grasp.titleMd,
    marginBlock: `calc((${grasp.titleMdLine} - ${grasp.titleMd}) / 2)`,
  },
  actionsSm: { minHeight: grasp.titleSmLine },
  titleWaitSm: {
    height: grasp.titleSm,
    marginBlock: `calc((${grasp.titleSmLine} - ${grasp.titleSm}) / 2)`,
  },
  // A description cut short at its line, with an ellipsis. Its height never changes.
  clamp: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  clampOne: { WebkitLineClamp: 1 },
  clampTwo: { WebkitLineClamp: 2 },
  // A description runs to its line's end: its placeholder does too.
  descriptionWait: { width: "100%" },
  // Its lines stacked as the description's own lines stand: no gap between them.
  descriptionWaitLines: { display: "grid", minWidth: 0 },
});

/** Each size's own look, over the large one's (none for `lg`). */
const sizeLooks = {
  lg: { title: null, description: null, actions: null, titleWait: null },
  md: {
    title: styles.titleMd,
    description: styles.descriptionSm,
    actions: styles.actionsMd,
    titleWait: styles.titleWaitMd,
  },
  sm: {
    title: styles.titleSm,
    description: styles.descriptionSm,
    actions: styles.actionsSm,
    titleWait: styles.titleWaitSm,
  },
} as const;

/** The description's placeholder: one Skeleton line per line it will take (the hint, else the clamp, else one). */
const DescriptionWait = ({
  lines,
  clamp,
}: {
  lines: number | undefined;
  clamp: 1 | 2 | "all";
}) => (
  <div {...stylex.props(styles.descriptionWaitLines)}>
    {Array.from(
      {
        length: Math.max(1, Math.round(lines ?? (clamp === "all" ? 1 : clamp))),
      },
      (_, index) => (
        <Skeleton key={index} text="lg" layout={styles.descriptionWait} />
      )
    )}
  </div>
);

/** Words that replace the placeholders fade in; a header that never waited is simply there. */
const useArrived = (loading: boolean) => {
  const [waited, setWaited] = useState(loading);
  if (loading && !waited) {
    setWaited(true);
  }
  return waited && !loading;
};

export const PageHeader = ({
  title,
  description,
  descriptionLines = "all",
  loadingLines,
  breadcrumb,
  aside,
  actions,
  tabs,
  loading = false,
  size = "lg",
  style: styleProp,
  layout,
}: PageHeaderProps) => {
  const look = sizeLooks[size];
  const arrived = useArrived(loading);
  return (
    <header
      data-slot="page-header"
      aria-busy={loading ? true : undefined}
      {...stylex.props(styles.header, layout ?? styleProp)}
    >
      {breadcrumb}
      <div {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.words)}>
          {loading ? (
            <>
              <Skeleton
                variant="block"
                layout={[styles.titleWait, look.titleWait]}
              />
              {description !== undefined && (
                <DescriptionWait
                  lines={loadingLines}
                  clamp={descriptionLines}
                />
              )}
            </>
          ) : (
            <>
              <div {...stylex.props(styles.titleRow, arrived && arrive.in)}>
                <h1 {...stylex.props(styles.title, look.title)}>{title}</h1>
                {aside}
              </div>
              {description !== undefined && (
                <p
                  title={
                    descriptionLines !== "all" &&
                    typeof description === "string"
                      ? description
                      : undefined
                  }
                  {...stylex.props(
                    styles.description,
                    look.description,
                    descriptionLines !== "all" && styles.clamp,
                    descriptionLines === 1 && styles.clampOne,
                    descriptionLines === 2 && styles.clampTwo,
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
          <div {...stylex.props(styles.actions, look.actions)}>{actions}</div>
        )}
      </div>
      {tabs !== undefined && <div {...stylex.props(styles.tabs)}>{tabs}</div>}
    </header>
  );
};
