// Page skeleton, table: a table page's pending state (a route's first paint, before its rows),
// built from the parts the page will show, so nothing moves when it arrives: PageHeader's own
// `loading`, then the page's own DataTable in its own `loading` (its toolbar and head as they will
// stand, its rows as the table's placeholders, each a real row's height). Give it the table's props
// as the page will (its columns, label, density, page size); only the rows wait.
//
//   <PageSkeletonTable table={{ label: "Invoices", columns, pageSize: 10 }} />
import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import { DataTable } from "../../data-table";
import type { DataTableProps } from "../../data-table";
import { PageHeader } from "../../page-header";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The header, then the table, a section's gap apart: as the loaded page lays them.
  page: { display: "grid", gap: grasp.space6, minWidth: 0 },
});

const noRows: readonly never[] = [];
const noKey = () => "";

export interface PageSkeletonTableProps<Row extends RowData> {
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
  /** The table as the page will give it, less its rows: its label, columns, density, page size. */
  table: Omit<DataTableProps<Row>, "rows" | "rowKey" | "loading">;
  /**
   * How many lines the page's description takes, so the header keeps its height: 0 for a page with
   * none, 2 where it wraps (a phone, a long line). @default 1
   */
  descriptionLines?: number;
}

/** A table page before its rows: the header's placeholders, then the table waiting in its own form. */
export const PageSkeletonTable = <Row extends RowData>({
  table,
  descriptionLines = 1,
  header = true,
  toolbar,
  actions,
}: PageSkeletonTableProps<Row>) => (
  <div
    data-slot="page-skeleton-table"
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
    <DataTable<Row> {...table} rows={noRows} rowKey={noKey} loading />
  </div>
);
