// Every word a Data grid shows or says, so a product can put them in its own language. Each has an
// English default. The product gives them in its languages through GraspWords (src/words), as the
// catalogue's `dataGrid`; a caller's `words` still wins until the breaking release's step 5.

/** The words of a Data grid. */
export interface DataGridWords {
  /** The row numbers' column. */
  row: string;
  /** A cell's name: its column and row. */
  cell: (column: string, row: number) => string;
  /** Said when a range is chosen. */
  chosen: (
    count: number,
    from: string,
    to: string,
    top: number,
    bottom: number
  ) => string;
  /** A ticked box's value. */
  ticked: string;
  /** An empty box's value. */
  unticked: string;
  /** A cell's editor: "Edit Budget, row 3". */
  edit: (cell: string) => string;
  /** Said when typed words do not fit the column: "Budget takes a figure". */
  invalid: (column: string, kind: string) => string;
  /** What each kind takes, for `invalid`. */
  takes: { figure: string; option: string };
  /** A column's resize handle: "Width of Owner". */
  width: (header: string) => string;
  /** Said after a copy. */
  copied: string;
  /** Said after a cut. */
  cut: string;
  /** Said after a paste. */
  pasted: string;
  /** Said after Delete clears the range. */
  cleared: string;
  /** Said after an undo. */
  undone: string;
  /** Said after a redo. */
  redone: string;
}

export const englishWords: DataGridWords = {
  row: "Row",
  cell: (column, row) => `${column}, row ${String(row)}`,
  chosen: (count, from, to, top, bottom) =>
    `${String(count)} cells chosen: ${from} to ${to}, rows ${String(top)} to ${String(bottom)}`,
  ticked: "Ticked",
  unticked: "Not ticked",
  edit: (cell) => `Edit ${cell}`,
  invalid: (column, kind) => `${column} takes ${kind}`,
  takes: { figure: "a figure", option: "one of its options" },
  width: (header) => `Width of ${header}`,
  copied: "Copied",
  cut: "Cut",
  pasted: "Pasted",
  cleared: "Cleared",
  undone: "Undone",
  redone: "Redone",
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    dataGrid: DataGridWords;
  }
}
