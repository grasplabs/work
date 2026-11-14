// PageHeader: the title row of a page. The page's title in the serif (Geist Serif 32/40, as Ruben's
// product sets it) with one line under it, the page's actions at the end of the row, and its tabs
// underneath. In an App shell the page's crumbs stand in the page bar; a page without one may put
// a Breadcrumb above the title. Palermo has no page header; this follows Grasp's type (title-lg is
// "a page title in the product", text-lg "the sentence under a page title").
//
//   <PageHeader
//     title="Spring launch"
//     description="Everything the team ships in March."
//     actions={<Button variant="ink">Share</Button>}
//     tabs={<Tabs ...>...</Tabs>}
//   />
//
// The title is the page's h1. Every value is a token (src/tokens). A caller may set layout only
// (the `style` prop). Words that replace their placeholders fade in (src/motion/arrive.ts).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { arrive } from "../motion/arrive";
import { Skeleton } from "../skeleton/skeleton";
import { grasp } from "../tokens/tokens.stylex";

type Layout = string | number | null;

/** What a caller may style: where the header sits, and how wide it is. Never its look. */
export type PageHeaderLayoutStyle = stylex.StyleXStyles<{
  width?: Layout;
  maxWidth?: Layout;
  alignSelf?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginBlockEnd?: Layout;
  marginInline?: Layout;
}>;

/** Every prop a PageHeader takes. */
export interface PageHeaderProps {
  /** The page's name, in sentence case ("Spring launch"). It is the page's h1. */
  title: ReactNode;
  /** One line under the title: what the page holds. */
  description?: ReactNode;
  /** Above the title: where the page sits, a Breadcrumb, for a page without an App shell (whose page bar holds the crumbs). */
  breadcrumb?: ReactNode;
  /** Beside the title: a badge that says its status. */
  aside?: ReactNode;
  /** At the end of the title row: the page's own buttons, the main one last. */
  actions?: ReactNode;
  /** Under the title: the page's Tabs, when it has views. */
  tabs?: ReactNode;
  /**
   * Placeholders where the title and the line will be, while the page loads.
   * @default false
   */
  loading?: boolean;
  /** Layout only: margins and width. The look belongs to the header. */
  style?: PageHeaderLayoutStyle;
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
  titleWait: { width: grasp.pageTitleWait, height: grasp.titleLgLine },
  descriptionWait: { width: grasp.sectionDescriptionWait },
});

export const PageHeader = ({
  title,
  description,
  breadcrumb,
  aside,
  actions,
  tabs,
  loading = false,
  style,
}: PageHeaderProps) => {
  // Words that replace the placeholders fade in; a header that never waited is simply there.
  const [waited, setWaited] = useState(loading);
  if (loading && !waited) {
    setWaited(true);
  }
  const arrived = waited && !loading;
  return (
    <header
      data-slot="page-header"
      aria-busy={loading ? true : undefined}
      {...stylex.props(styles.header, style)}
    >
      {breadcrumb}
      <div {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.words)}>
          {loading ? (
            <>
              <Skeleton shape="block" layout={styles.titleWait} />
              {description !== undefined && (
                <Skeleton text="lg" layout={styles.descriptionWait} />
              )}
            </>
          ) : (
            <>
              <div {...stylex.props(styles.titleRow, arrived && arrive.in)}>
                <h1 {...stylex.props(styles.title)}>{title}</h1>
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
      {tabs !== undefined && <div {...stylex.props(styles.tabs)}>{tabs}</div>}
    </header>
  );
};
