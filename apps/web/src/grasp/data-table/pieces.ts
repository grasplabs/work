// The Data table's pieces: features beyond sorting, searching, choosing and pages, each brought in
// only by the table that uses it (engine.ts). Plain constants, so a bundle leaves out the ones no
// table imports.
//
//   import { DataTable, view, resizing, ordering, pinning } from "@/components/grasp/data-table";
//   <DataTable pieces={[view, resizing]} ... />
import {
  columnGroupingFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createExpandedRowModel,
  createGroupedRowModel,
  rowExpandingFeature,
} from "@tanstack/react-table";

import type { DataTablePiece } from "./engine";

/** A View menu that hides and shows columns, and Hide in each column's menu. */
export const view: DataTablePiece = {
  name: "view",
  features: { columnVisibilityFeature },
};

/**
 * Columns that keep their widths and can be made wider or narrower: by the handle at a head's
 * end (dragged, or focused and moved with the arrow keys), and back to its first width by a
 * double press.
 */
export const resizing: DataTablePiece = {
  name: "resizing",
  features: { columnSizingFeature, columnResizingFeature },
};

/** Columns that can be moved: by dragging a head, or by Move earlier and Move later in its menu. */
export const ordering: DataTablePiece = {
  name: "ordering",
  features: { columnOrderingFeature },
};

/** Columns held at the start or the end while the rest scroll sideways, from each column's menu. */
export const pinning: DataTablePiece = {
  name: "pinning",
  features: { columnSizingFeature, columnPinningFeature },
};

/** Rows that open: a detail under the row (`detail`), or rows of their own under it (`subRows`). */
export const expanding: DataTablePiece = {
  name: "expanding",
  features: { rowExpandingFeature, expandedRowModel: createExpandedRowModel() },
};

/** Rows gathered under a heading row per value of one column (`groupBy`), each with its count. */
export const grouping: DataTablePiece = {
  name: "grouping",
  features: {
    columnGroupingFeature,
    rowExpandingFeature,
    groupedRowModel: createGroupedRowModel(),
    expandedRowModel: createExpandedRowModel(),
  },
};
