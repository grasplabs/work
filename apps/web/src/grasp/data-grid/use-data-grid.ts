// The Data grid's model: TanStack's table (the rows as sorted, the columns' widths), the
// spreadsheet's state (the active cell and range, the open editor, the edits made), and what can be
// done to them. The grid stores no data: every edit leaves as a patch through `onPatch`.
"use client";

import { functionalUpdate, useTable } from "@tanstack/react-table";
import type {
  ColumnDef,
  ColumnSizingState,
  RowData,
  SortingState,
} from "@tanstack/react-table";
import { useState } from "react";

import { grasp } from "../tokens/tokens.stylex";
import { useWords, useWordsLocale, withGiven } from "../words/words";
import { features } from "./engine";
import type { Features } from "./engine";
import { at, fit, history, isRange, record, rectOf, redo, undo } from "./model";
import type {
  Cell,
  CellValue,
  Change,
  History,
  Patch,
  Rect,
  Selection,
} from "./model";
import type { DataGridColumn, DataGridProps } from "./types";
import { clearedOf, valueFrom } from "./values";
import { englishWords } from "./words";

/** The open editor: the words typed so far, in the active cell. */
export interface Editing {
  /** What the editor holds. */
  text: string;
  /** It opened on the cell's own words, all selected; typing a letter opens it on that letter. */
  all: boolean;
  /** Its words did not fit the column when Enter was pressed. */
  wrong: boolean;
}

const origin: Selection = at({ row: 0, col: 0 });

const asText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const compare = (a: unknown, b: unknown) => {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return asText(a).localeCompare(asText(b), undefined, { numeric: true });
};

const defsFor = <Row extends RowData>(
  columns: readonly DataGridColumn<Row>[]
): ColumnDef<Features, Row>[] =>
  columns.map((column): ColumnDef<Features, Row> => ({
    id: column.key,
    accessorFn: (row: Row) => column.value(row),
    header: column.header,
    enableSorting: column.sortable === true,
    sortDescFirst: false,
    sortFn: (a, b, id) => compare(a.getValue(id), b.getValue(id)),
  }));

/** The columns' tracks: a given width, or never narrower than the widest cell, sharing spare room. */
const templateFor = <Row>(
  columns: readonly DataGridColumn<Row>[],
  widths: ColumnSizingState,
  numbered: boolean
) => {
  const tracks = columns.map((column) => {
    const width = widths[column.key];
    return width === undefined
      ? `minmax(max-content, ${String(column.grow ?? 1)}fr)`
      : `${String(Math.round(width))}px`;
  });
  return [...(numbered ? [grasp.gridNumberWidth] : []), ...tracks].join(" ");
};

/** Every cell of a rectangle, row by row. */
export const cellsOf = (rect: Rect): Cell[] => {
  const cells: Cell[] = [];
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    for (let col = rect.left; col <= rect.right; col += 1) {
      cells.push({ row, col });
    }
  }
  return cells;
};

/** The next sort after a press on a column's name: up, then down, then as given. */
const nextSort = (sorting: SortingState, key: string): SortingState => {
  const [now] = sorting;
  if (now?.id !== key) {
    return [{ id: key, desc: false }];
  }
  return now.desc ? [] : [{ id: key, desc: true }];
};

export type GridModel<Row extends RowData> = ReturnType<
  typeof useDataGrid<Row>
>;

/** The grid's model. */
export const useDataGrid = <Row extends RowData>(props: DataGridProps<Row>) => {
  const { columns, rowKey, onPatch } = props;
  // Its words: the product's, by its catalogue, else English; the caller's `words` still win. Its
  // figures in the catalogue's locale, unless the caller gives one.
  const words = withGiven(
    useWords("dataGrid", englishWords),
    props.words ?? {}
  );
  const catalogueLocale = useWordsLocale();
  const numbered = props.numbered !== false;
  const locale = props.locale ?? catalogueLocale ?? "en";
  const [sorting, setSorting] = useState<SortingState>([]);
  const [widths, setWidths] = useState<ColumnSizingState>({});
  const [chosen, setChosen] = useState<Selection>(
    props.defaultSelection ?? origin
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  const [past, setPast] = useState<History>(history);
  const [said, setSaid] = useState("");

  const table = useTable<Features, Row>({
    features,
    columns: defsFor(columns),
    data: props.rows,
    getRowId: (row) => rowKey(row),
    state: { sorting, columnSizing: widths },
    onSortingChange: (updater) => {
      setSorting((now) => functionalUpdate(updater, now));
    },
    onColumnSizingChange: (updater) => {
      setWidths((now) => functionalUpdate(updater, now));
    },
  });

  // The rows as shown, as plain data: TanStack keeps its row objects as they are while their state
  // changes, so the parts are given values, never a row.
  const shown = table
    .getRowModel()
    .rows.map((row) => ({ id: row.id, data: row.original }));
  const extent = { rows: shown.length, cols: columns.length };
  // Rows can go while a cell among them is chosen: the selection stays inside the grid.
  const selection = fit(chosen, extent);
  const rect = rectOf(selection);
  const ranged = isRange(selection);

  const valueAt = ({ row, col }: Cell): CellValue | undefined => {
    const column = columns[col];
    const line = shown[row];
    return column === undefined || line === undefined
      ? undefined
      : column.value(line.data);
  };
  /** Whether a column's cells take edits at all. */
  const editable = (col: number) =>
    onPatch !== undefined &&
    columns[col] !== undefined &&
    columns[col].readOnly !== true;

  const changeAt = (cell: Cell, to: CellValue | undefined): Change | null => {
    const column = columns[cell.col];
    const line = shown[cell.row];
    const from = valueAt(cell);
    if (
      column === undefined ||
      line === undefined ||
      from === undefined ||
      to === undefined ||
      !editable(cell.col)
    ) {
      return null;
    }
    return { rowId: line.id, columnId: column.key, from, to };
  };

  /** An edit leaves as a patch, and can be undone. Changes that change nothing are dropped. */
  const commit = (
    kind: Patch["kind"],
    changes: (Change | null)[],
    message: string
  ) => {
    const real = changes.filter(
      (change): change is Change => change !== null && change.from !== change.to
    );
    if (real.length === 0 || onPatch === undefined) {
      return;
    }
    const patch = { kind, changes: real };
    onPatch(patch);
    setPast((state) => record(state, patch));
    setSaid(message);
  };

  const step = (back: boolean) => {
    const done = back ? undo(past) : redo(past);
    if (done === null || onPatch === undefined) {
      return;
    }
    onPatch(done.patch);
    setPast(done.state);
    setSaid(back ? words.undone : words.redone);
  };

  const choose = (next: Selection) => {
    setChosen(next);
    if (!isRange(next)) {
      setSaid("");
      return;
    }
    const box = rectOf(next);
    const count = (box.bottom - box.top + 1) * (box.right - box.left + 1);
    setSaid(
      words.chosen(
        count,
        columns[box.left]?.header ?? "",
        columns[box.right]?.header ?? "",
        box.top + 1,
        box.bottom + 1
      )
    );
  };

  /** Ticks or unticks a box's cell. */
  const tick = (cell: Cell) => {
    const column = columns[cell.col];
    if (column?.kind !== "checkbox") {
      return;
    }
    const next = valueAt(cell) !== true;
    commit(
      "edit",
      [changeAt(cell, next)],
      `${words.cell(column.header, cell.row + 1)}: ${next ? words.ticked : words.unticked}`
    );
  };

  const clear = (kind: "clear" | "cut") => {
    commit(
      kind,
      cellsOf(rect).map((cell) =>
        changeAt(cell, clearedOf(columns[cell.col]?.kind ?? "text"))
      ),
      kind === "cut" ? words.cut : words.cleared
    );
  };

  /** Puts words into cells, each read as its column reads them; words that do not fit are left out. */
  const write = (target: Rect, text: (row: number, col: number) => string) => {
    commit(
      "paste",
      cellsOf(target).map((cell) => {
        const column = columns[cell.col];
        return column === undefined
          ? null
          : changeAt(cell, valueFrom(column, text(cell.row, cell.col), locale));
      }),
      words.pasted
    );
  };

  /** Whether the active cell opens an editor: a box is ticked instead. */
  const canEdit =
    editable(selection.active.col) &&
    columns[selection.active.col]?.kind !== "checkbox";

  /** Opens the editor on the active cell: on its own words, or on a typed letter. */
  const startEdit = (typed?: string) => {
    if (!canEdit) {
      return;
    }
    const value = valueAt(selection.active);
    const own = value === undefined || value === null ? "" : String(value);
    setEditing({ text: typed ?? own, all: typed === undefined, wrong: false });
  };

  /**
   * Commits the editor's words and says whether it can close: words that do not fit the column
   * keep it open, marked wrong, unless `quietly` (focus has left: the cell keeps what it held).
   */
  const settle = (quietly = false): boolean => {
    const column = columns[selection.active.col];
    if (editing === null || column === undefined) {
      return true;
    }
    const value = valueFrom(column, editing.text, locale);
    if (value === undefined && !quietly) {
      setEditing({ ...editing, wrong: true });
      const takes =
        column.kind === "select" ? words.takes.option : words.takes.figure;
      setSaid(words.invalid(column.header, takes));
      return false;
    }
    commit("edit", [changeAt(selection.active, value)], "");
    setEditing(null);
    return true;
  };

  const sortOf = (key: string): "ascending" | "descending" | undefined => {
    const [now] = sorting;
    if (now?.id !== key) {
      return undefined;
    }
    return now.desc ? "descending" : "ascending";
  };

  return {
    words,
    columns,
    numbered,
    shown,
    extent,
    selection,
    rect,
    ranged,
    editing,
    said,
    widths,
    template: templateFor(columns, widths, numbered),
    readOnly: onPatch === undefined,
    tabLeaves: props.tab === "leave",
    valueAt,
    editable,
    canEdit,
    choose,
    grow: (active: Cell) => {
      setChosen((now) => ({ anchor: now.anchor, active }));
    },
    tick,
    clear,
    write,
    step,
    startEdit,
    type: (text: string) => {
      setEditing((now) =>
        now === null ? now : { ...now, text, wrong: false }
      );
    },
    settle,
    cancelEdit: () => {
      setEditing(null);
    },
    say: setSaid,
    sortOf,
    sort: (key: string) => {
      table.setSorting(nextSort(sorting, key));
    },
    resize: (key: string, width: number) => {
      table.setColumnSizing({ ...widths, [key]: width });
    },
    autoFit: (key: string) => {
      table.setColumnSizing(
        Object.fromEntries(
          Object.entries(widths).filter(([each]) => each !== key)
        )
      );
    },
  };
};
