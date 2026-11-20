// The Data grid's engine: TanStack Table (v9, pinned), as the Data table's is, with the features a
// grid uses today: sorting, and columns that keep and change their widths. One features object,
// made once, as TanStack wants.
import {
  columnResizingFeature,
  columnSizingFeature,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/react-table";

export const features = tableFeatures({
  rowSortingFeature,
  columnSizingFeature,
  columnResizingFeature,
  sortedRowModel: createSortedRowModel(),
});

/** The grid's features, as the types see them. */
export type Features = typeof features;
