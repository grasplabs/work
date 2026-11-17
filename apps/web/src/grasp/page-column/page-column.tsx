// Page column: a page's content in one column of a reading width, standing at the page's start, as a
// settings page has it (the product's Settings: one screen per section, a column about 720px wide
// beside the nav). A child that needs the page's whole width, a table, stands in PageColumnWide.
//
//   <PageColumn>
//     <SectionCard flush density="compact" title="Workspace"><SettingsRows>…</SettingsRows></SectionCard>
//     <PageColumnWide><DataTable … /></PageColumnWide>
//   </PageColumn>
//
// The column is the frame's width less what is past the measure, so it narrows with the page and
// never runs wider. Every value is a token.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp } from "../tokens/tokens.stylex";

/** What a caller may style: where the column sits and how much room it takes. */
export type PageColumnLayoutStyle = LayoutStyle;

/** Every prop a PageColumn takes. */
export interface PageColumnProps {
  /** The page's content, top to bottom: groups of rows, and PageColumnWide for a table. */
  children: ReactNode;
  /**
   * How wide the column runs: `column` (page-column-measure, 45rem) for settings and forms,
   * `page` (page-measure, 64rem) for a page of wider things.
   * @default "column"
   */
  measure?: "column" | "page";
  /** Layout only. */
  layout?: PageColumnLayoutStyle;
}

/** Every prop a PageColumnWide takes. */
export interface PageColumnWideProps {
  /** What runs the page's whole width: a table, a chart. */
  children: ReactNode;
}

const styles = stylex.create({
  // The frame: the width the column measures against, and what a wide child runs. Measured as a
  // container it has no width of its own, so it takes its parent's.
  frame: { containerType: "inline-size", width: "100%", minWidth: 0 },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    boxSizing: "border-box",
    minWidth: 0,
  },
  column_column: {
    paddingInlineEnd: `max(0px, calc(100% - ${grasp.pageColumnMeasure}))`,
  },
  column_page: {
    paddingInlineEnd: `max(0px, calc(100% - ${grasp.pageMeasure}))`,
  },
  wide: { width: "100cqi", minWidth: 0 },
});

/** A page's content in one column of a reading width, at the page's start. */
export const PageColumn = ({
  children,
  measure = "column",
  layout,
}: PageColumnProps) => (
  <div
    data-slot="page-column"
    data-measure={measure}
    {...stylex.props(styles.frame, layout)}
  >
    <div
      {...stylex.props(
        styles.column,
        measure === "page" ? styles.column_page : styles.column_column
      )}
    >
      {children}
    </div>
  </div>
);

/** A child of PageColumn that runs the page's whole width. */
export const PageColumnWide = ({ children }: PageColumnWideProps) => (
  <div data-slot="page-column-wide" {...stylex.props(styles.wide)}>
    {children}
  </div>
);
