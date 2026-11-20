// Page column: a page's content in one column of a reading width, at the page's start or in its
// middle (`align="center"`), as a settings page has it. A child that needs the page's whole width, a
// table, stands in PageColumnWide.
//
//   <PageColumn measure="settings" align="center">
//     <PageHeader size="md" title="General" />
//     <SectionCard variant="grouped" flush density="compact" title="Interface">
//       <SettingsRows controls="fit">…</SettingsRows>
//     </SectionCard>
//     <PageColumnWide><DataTable … /></PageColumnWide>
//   </PageColumn>
//
// The column is the frame's width less what is past the measure, so it narrows with the page and
// never runs wider. Every value is a token.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp } from "../tokens/tokens.stylex";
import { pageColumnVars } from "./page-column.stylex";

/** What a caller may style: where the column sits and how much room it takes. */
export type PageColumnLayoutStyle = LayoutStyle;

/** Every prop a PageColumn takes. */
export interface PageColumnProps {
  /** The page's content, top to bottom: groups of rows, and PageColumnWide for a table. */
  children: ReactNode;
  /**
   * How wide the column runs: `column` (page-column-measure, 45rem) for forms, `settings`
   * (page-settings-measure, 40rem) for a settings page, `page` (page-measure, 64rem) for a page of
   * wider things.
   * @default "column"
   */
  measure?: "column" | "settings" | "page";
  /**
   * Where the column stands: at the page's start, or in its middle with the room past the measure
   * shared on both sides (a settings page).
   * @default "start"
   */
  align?: "start" | "center";
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
  start: {
    paddingInlineEnd: `max(0px, calc(100cqi - ${pageColumnVars.measure}))`,
  },
  // In the middle: what is past the measure, half on each side; a wide child steps back by one side.
  center: {
    paddingInline: `max(0px, calc((100cqi - ${pageColumnVars.measure}) / 2))`,
    [pageColumnVars.wideStart]: `min(0px, calc((${pageColumnVars.measure} - 100cqi) / 2))`,
  },
  measure_column: { [pageColumnVars.measure]: grasp.pageColumnMeasure },
  measure_settings: { [pageColumnVars.measure]: grasp.pageSettingsMeasure },
  measure_page: { [pageColumnVars.measure]: grasp.pageMeasure },
  wide: {
    width: "100cqi",
    minWidth: 0,
    marginInlineStart: pageColumnVars.wideStart,
  },
});

const measures = {
  column: styles.measure_column,
  settings: styles.measure_settings,
  page: styles.measure_page,
} as const;

/** A page's content in one column of a reading width, at the page's start or in its middle. */
export const PageColumn = ({
  children,
  measure = "column",
  align = "start",
  layout,
}: PageColumnProps) => (
  <div
    data-slot="page-column"
    data-measure={measure}
    data-align={align}
    {...stylex.props(styles.frame, layout)}
  >
    <div
      {...stylex.props(
        styles.column,
        measures[measure],
        align === "center" ? styles.center : styles.start
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
