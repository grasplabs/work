// DataGrid is a folder because its spreadsheet rules (model.ts: the keys, TSV, how typed words are
// read, the sort and undo, pure and with no React) are checked on their own, without a page.
export { DataGrid } from "./data-grid";
export type {
  DataGridActiveAppearance,
  DataGridAppearance,
  DataGridHeaderAppearance,
  DataGridProps,
  DataGridRangeAppearance,
} from "./data-grid";
export { applyDataGridPatch } from "./model";
export type {
  DataGridCell,
  DataGridCellValue,
  DataGridChange,
  DataGridColumn,
  DataGridColumnType,
  DataGridPatch,
  DataGridSelection,
} from "./model";
