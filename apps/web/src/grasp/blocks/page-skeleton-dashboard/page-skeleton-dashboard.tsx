// Page skeleton, dashboard: a page of a chart, its figures and a table (the product's Runs and
// Requests) before its data arrives, built from the parts the page will show, so nothing moves when
// it does: PageHeader's own `loading`; the chart's card with its title in the host's words and the
// chart's box standing still at the chart's height; the figures as StatsGrid's own `loading`, each
// under its title; then the page's DataTable in its own `loading`. Give it what the page will give
// those parts; only the data waits.
//
//   <PageSkeletonDashboard
//     chart={{ title: "Runs a week" }}
//     stats={{ "aria-label": "This week", titles: ["Runs", "Failed", "Waiting on you"] }}
//     table={{ label: "Runs", columns }}
//   />
import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import { chartInset } from "../../chart/chart";
import { chartAxisRoom } from "../../chart/chart-axis";
import { DataTable } from "../../data-table";
import type { DataTableProps } from "../../data-table";
import { PageHeader } from "../../page-header";
import { SectionCard } from "../../section-card";
import { StatsGrid } from "../../stats";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, the chart, the figures and the table, a section's gap apart: as the loaded page lays them.
  page: { display: "grid", gap: grasp.pageGap, minWidth: 0 },
  // The chart's box: as tall as the chart will draw, across its card.
  // The chart's frame while it waits: as tall as the chart, its level lines where the chart draws
  // them (inside its inset, after the y axis's room, above the x axis's), dotted 2 on 2 in the line
  // token as ChartGrid's, and nothing filled: the bars arrive into lines already there.
  frame: (height: number) => ({ position: "relative", width: "100%", height }),
  level: (top: number, left: number, right: number) => ({
    position: "absolute",
    top,
    left,
    right,
    height: 1,
    backgroundImage: `repeating-linear-gradient(to right, ${grasp.line} 0 2px, transparent 2px 4px)`,
  }),
});

const noRows: readonly never[] = [];
/** The level lines a chart draws (its y axis's ticks), the lowest its baseline. */
const LINES = 5;
const noKey = () => "";

export interface PageSkeletonDashboardProps<Row extends RowData> {
  /**
   * The page's own header (PageHeader's `loading`). `false` under a layout that already draws the
   * page's title (a settings section) or on a page with none (Inbox): the content starts at the top.
   * @default true
   */
  header?: boolean;
  /**
   * Between the header and the content: the page's tabs, search field or filters, as the loaded page
   * has them where they need no data, else a PageSkeletonToolbar of their kind, so the content
   * stands where it will.
   */
  toolbar?: ReactNode;
  /**
   * The page's actions in its header, as the loaded page has them (they need no data): drawn in
   * their place, so actions that wrap under the title on a phone take their room at once and the
   * content does not drop when the page arrives.
   */
  actions?: ReactNode;
  /**
   * The chart's card as the page will show it: its title, in the host's words, and the chart's
   * height (Chart's own `height`). Leave it out for a page with no chart.
   */
  chart?: { title: string; height?: number };
  /** The figures as the page will show them: their row's name and each one's title, in order. */
  stats: { "aria-label": string; titles: readonly string[] };
  /** The table as the page will give it, less its rows: its label, columns, density, page size. */
  table: Omit<DataTableProps<Row>, "rows" | "rowKey" | "loading">;
  /**
   * How many lines the page's description takes, so the header keeps its height: 0 for a page with
   * none, 2 where it wraps (a phone, a long line). @default 1
   */
  descriptionLines?: number;
}

/** The chart's level lines at their places, at the chart's height, with no marks: a chart's own frame while it waits, wherever it stands (a settings card's too). */
export const PageSkeletonChartFrame = ({ height }: { height: number }) => {
  const plot = height - chartInset.top - chartAxisRoom.x;
  return (
    <div data-slot="chart-frame" {...stylex.props(styles.frame(height))}>
      {Array.from({ length: LINES }, (_, index) => (
        <span
          key={index}
          {...stylex.props(
            styles.level(
              chartInset.top + (plot * index) / (LINES - 1),
              chartAxisRoom.y,
              chartInset.right
            )
          )}
        />
      ))}
    </div>
  );
};

/** A dashboard page before its data: the header's placeholders, the chart's still box, the figures and the table waiting. */
export const PageSkeletonDashboard = <Row extends RowData>({
  chart,
  stats,
  table,
  descriptionLines = 1,
  header = true,
  toolbar,
  actions,
}: PageSkeletonDashboardProps<Row>) => (
  <div
    data-slot="page-skeleton-dashboard"
    aria-busy={header ? undefined : true}
    {...stylex.props(styles.page)}
  >
    {header ? (
      <PageHeader
        title=""
        description={descriptionLines > 0 ? "" : undefined}
        loadingLines={descriptionLines}
        actions={actions}
        loading
      />
    ) : null}
    {toolbar}
    {chart === undefined ? null : (
      <SectionCard title={chart.title}>
        <div aria-hidden="true">
          <PageSkeletonChartFrame height={chart.height ?? 240} />
        </div>
      </SectionCard>
    )}
    <StatsGrid
      aria-label={stats["aria-label"]}
      items={stats.titles.map((title) => ({ title, value: "" }))}
      loading
    />
    <DataTable<Row> {...table} rows={noRows} rowKey={noKey} loading />
  </div>
);
