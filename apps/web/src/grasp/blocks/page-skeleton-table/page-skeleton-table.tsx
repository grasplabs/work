// Page skeleton, table: a table page's pending state (a route's first paint, before its rows),
// built from the parts the page will show, so nothing moves when it arrives: PageHeader's own
// `loading`, then the page's own DataTable in its own `loading` (its toolbar and head as they will
// stand, its rows as the table's placeholders, each a real row's height). Give it the table's props
// as the page will (its columns, label, density, page size); only the rows wait.
//
//   <PageSkeletonTable table={{ label: "Invoices", columns, pageSize: 10 }} />
import * as stylex from "@stylexjs/stylex";
import type { RowData } from "@tanstack/react-table";

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
}: PageSkeletonTableProps<Row>) => (
  <div data-slot="page-skeleton-table" {...stylex.props(styles.page)}>
    <PageHeader
      title=""
      description={descriptionLines > 0 ? "" : undefined}
      loadingLines={descriptionLines}
      loading
    />
    <DataTable<Row> {...table} rows={noRows} rowKey={noKey} loading />
  </div>
);
