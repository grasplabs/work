// The Data table's model: its own state (or yours, where you keep it), TanStack's table, and the
// layout of the columns shown: which, in what order, held where, how wide. The parts draw from it.
"use client";

import { functionalUpdate, useTable } from "@tanstack/react-table";
import type {
  Column,
  ColumnDef,
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ColumnVisibilityState,
  ExpandedState,
  PaginationState,
  ReactTable,
  Row as TableRow,
  RowData,
  RowSelectionState,
  SortingState,
  TableState,
  Updater,
} from "@tanstack/react-table";
import { useLayoutEffect, useRef, useState } from "react";

import type { FilterCondition } from "../filter-builder";
import type { TablePin } from "../table";
import { featuresFor, has } from "./engine";
import type { DataTablePiece, Features } from "./engine";
import { isSet, passes } from "./filters";
import type { DataTableColumn, DataTableProps, DataTableSort } from "./types";

export type Model<Row extends RowData> = ReturnType<
  typeof useDataTable<Row>
>["model"];
export type TableColumn<Row extends RowData> = Column<Features, Row>;
export type TableRowOf<Row extends RowData> = TableRow<Features, Row>;

const noPieces: readonly DataTablePiece[] = [];
const noKeys: readonly string[] = [];
export const noCondition: FilterCondition = {
  fieldId: null,
  operatorId: null,
  value: null,
};

const asText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const compare = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number"
    ? a - b
    : asText(a).localeCompare(asText(b), undefined, { numeric: true });

const toSorting = (sort: readonly DataTableSort[]): SortingState =>
  sort.map(({ key, order }) => ({ id: key, desc: order === "descending" }));
const fromSorting = (sorting: SortingState): DataTableSort[] =>
  sorting.map(({ id, desc }) => ({
    key: id,
    order: desc ? "descending" : "ascending",
  }));

/** One sort, several, or none, as a list. */
export const listOf = (
  sort: DataTableSort | readonly DataTableSort[] | undefined
): readonly DataTableSort[] => {
  if (sort === undefined) {
    return [];
  }
  return "key" in sort ? [sort] : sort;
};

const near = (value: number) => Math.round(value);
const px = (value: number) => `${near(value)}px`;

// A token's length in pixels, read from the page.
export const lengthOf = (element: Element, name: string, fallback: number) => {
  const value = Number(
    getComputedStyle(element).getPropertyValue(name).replace("px", "")
  );
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// Whether a press had Shift down: it adds a column to the sort, or a range of rows to the choice.
const pressed = (event: unknown) =>
  typeof event === "object" &&
  event !== null &&
  "shiftKey" in event &&
  event.shiftKey === true;

const defsFor = <Row extends RowData>(
  columns: readonly DataTableColumn<Row>[]
): ColumnDef<Features, Row>[] =>
  columns.map((column, index): ColumnDef<Features, Row> => ({
    id: column.key,
    accessorFn: (row: Row) => column.value(row),
    header: column.header,
    enableSorting: column.sortable === true,
    sortDescFirst: false,
    sortFn: (a, b, id) => compare(a.getValue(id), b.getValue(id)),
    // The first column names the row: it is never hidden.
    enableHiding: index !== 0,
    enableColumnFilter: column.filter !== false,
    filterFn: (row, id, wanted: FilterCondition) =>
      passes(row.getValue(id), wanted),
  }));

const startVisibility = <Row>(
  columns: readonly DataTableColumn<Row>[]
): ColumnVisibilityState =>
  Object.fromEntries(
    columns
      .filter((column) => column.hidden === true)
      .map((column) => [column.key, false])
  );

const startPinned = <Row>(
  columns: readonly DataTableColumn<Row>[],
  stickyFirst: boolean
): ColumnPinningState => {
  const lead = columns[0]?.key;
  const first = stickyFirst && lead !== undefined ? [lead] : [];
  return {
    start: [
      ...first,
      ...columns
        .filter((column) => column.pin === "start" && column.key !== lead)
        .map((column) => column.key),
    ],
    end: columns
      .filter((column) => column.pin === "end")
      .map((column) => column.key),
  };
};

/** The state a table keeps itself, or takes from its props where you keep it. */
const useOwnState = <Row extends RowData>(props: DataTableProps<Row>) => {
  const [ownSort, setOwnSort] = useState<readonly DataTableSort[]>(() =>
    listOf(props.defaultSort)
  );
  const [ownQuery, setOwnQuery] = useState("");
  const [ownPage, setOwnPage] = useState(1);
  const [ownChosen, setOwnChosen] = useState<readonly string[]>(
    props.defaultSelected ?? noKeys
  );
  const [condition, setCondition] = useState<FilterCondition>(noCondition);
  const [visibility, setVisibility] = useState<ColumnVisibilityState>(() =>
    startVisibility(props.columns)
  );
  const [order, setOrder] = useState<ColumnOrderState>(() =>
    props.columns.map((column) => column.key)
  );
  const [pinned, setPinned] = useState<ColumnPinningState>(() =>
    startPinned(props.columns, props.stickyFirst === true)
  );
  const [widths, setWidths] = useState<ColumnSizingState>({});
  const [expanded, setExpanded] = useState<ExpandedState>(() =>
    props.groupBy === undefined ? {} : true
  );
  const sort = props.sort ?? ownSort;
  const query = props.query ?? ownQuery;
  const chosen = props.selected ?? ownChosen;
  const setPage = (next: number) => {
    if (props.page === undefined) {
      setOwnPage(next);
    }
    props.onPageChange?.(next);
  };
  const setSort = (next: DataTableSort[]) => {
    if (props.sort === undefined) {
      setOwnSort(next);
    }
    props.onSortChange?.(next);
    setPage(1);
  };
  const setQuery = (next: string) => {
    if (props.query === undefined) {
      setOwnQuery(next);
    }
    props.onQueryChange?.(next);
    setPage(1);
  };
  const setChosen = (next: string[]) => {
    if (props.selected === undefined) {
      setOwnChosen(next);
    }
    props.onSelectedChange?.(next);
  };
  return {
    sort,
    setSort,
    query,
    setQuery,
    page: props.page ?? ownPage,
    setPage,
    chosen,
    setChosen,
    condition,
    setCondition,
    visibility,
    setVisibility,
    order,
    setOrder,
    pinned,
    setPinned,
    widths,
    setWidths,
    expanded,
    setExpanded,
  };
};
export type OwnState = ReturnType<typeof useOwnState>;

/**
 * Sized columns start at the widths their words gave them, measured before the first paint, so
 * nothing moves when the table switches to fixed widths. The checkboxes' column is measured too: a
 * held first column stands that far from the start.
 */
const useMeasure = (
  sizing: boolean,
  setWidths: (widths: ColumnSizingState) => void
) => {
  const holder = useRef<HTMLDivElement>(null);
  const [chooseWidth, setChooseWidth] = useState(0);
  const [first, setFirst] = useState<ColumnSizingState>({});
  const [narrowest, setNarrowest] = useState(64);
  const [step, setStep] = useState(16);
  const [boxWidth, setBoxWidth] = useState(0);
  // How wide the table's box is, as it changes: held columns let go when they would take more
  // than half of it.
  useLayoutEffect(() => {
    const box = holder.current?.querySelector("[data-slot=table-container]");
    const watch = new ResizeObserver(([entry]) => {
      setBoxWidth(near(entry?.contentRect.width ?? 0));
    });
    if (box !== null && box !== undefined) {
      watch.observe(box);
    }
    return () => {
      watch.disconnect();
    };
  }, []);
  useLayoutEffect(() => {
    const element = holder.current;
    if (element === null) {
      return;
    }
    const measured: ColumnSizingState = {};
    for (const head of element.querySelectorAll<HTMLTableCellElement>(
      "thead th[data-column]"
    )) {
      const key = head.dataset.column;
      if (key !== undefined) {
        measured[key] = near(head.getBoundingClientRect().width);
      }
    }
    const choose = element.querySelector("thead [data-choose]")?.closest("th");
    if (choose !== null && choose !== undefined) {
      setChooseWidth(near(choose.getBoundingClientRect().width));
    }
    setNarrowest(lengthOf(element, "--grasp-table-column-min", 64));
    setStep(lengthOf(element, "--grasp-table-resize-step", 16));
    setFirst(measured);
    if (sizing) {
      setWidths(measured);
    }
  }, [sizing, setWidths]);
  return { holder, chooseWidth, first, narrowest, step, boxWidth };
};

/** The columns as shown: visible ones, in their order, held start ones first and end ones last. */
const arrange = <Row extends RowData>(
  table: ReactTable<Features, Row>,
  own: OwnState,
  flags: {
    hiding: boolean;
    ordering: boolean;
    pinning: boolean;
    stickyFirst: boolean;
    lead: string | undefined;
  }
) => {
  const leaves = flags.hiding
    ? table.getVisibleLeafColumns()
    : table.getAllLeafColumns();
  const byKey = (key: string) => leaves.find((column) => column.id === key);
  const ordered = flags.ordering
    ? own.order
        .map(byKey)
        .filter((column): column is TableColumn<Row> => column !== undefined)
    : leaves;
  const leadOnly =
    flags.stickyFirst && flags.lead !== undefined ? [flags.lead] : [];
  const startKeys = flags.pinning ? (own.pinned.start ?? []) : leadOnly;
  const endKeys = flags.pinning ? (own.pinned.end ?? []) : [];
  const held = (keys: readonly string[]) =>
    keys
      .map(byKey)
      .filter((column): column is TableColumn<Row> => column !== undefined);
  const start = held(startKeys);
  const end = held(endKeys);
  const middle = ordered.filter(
    (column) => !startKeys.includes(column.id) && !endKeys.includes(column.id)
  );
  return { shown: [...start, ...middle, ...end], start, end };
};

type Flags = ReturnType<typeof flagsFor>;

const flagsFor = <Row>(props: DataTableProps<Row>) => {
  const pieces = props.pieces ?? noPieces;
  return {
    hiding: has(pieces, "view"),
    resizing: has(pieces, "resizing"),
    sizing: has(pieces, "resizing") || has(pieces, "pinning"),
    ordering: has(pieces, "ordering"),
    pinning: has(pieces, "pinning"),
    expanding: has(pieces, "expanding") || has(pieces, "grouping"),
    grouping: has(pieces, "grouping") && props.groupBy !== undefined,
    stickyFirst: props.stickyFirst === true,
    lead: props.columns[0]?.key,
  };
};

/** The state TanStack is given: the base slices, and each piece's while the table holds it. */
const stateFor = (
  own: OwnState,
  flags: Flags,
  groupBy: string | undefined,
  base: Partial<TableState<Features>>
) => {
  const state: Partial<TableState<Features>> = { ...base };
  if (flags.hiding) {
    state.columnVisibility = own.visibility;
  }
  if (flags.ordering) {
    state.columnOrder = own.order;
  }
  if (flags.pinning) {
    state.columnPinning = own.pinned;
  }
  if (flags.sizing) {
    state.columnSizing = own.widths;
  }
  if (flags.expanding) {
    state.expanded = own.expanded;
  }
  if (flags.grouping && groupBy !== undefined) {
    state.grouping = [groupBy];
  }
  return state;
};

const keysOn = (selection: RowSelectionState) =>
  Object.entries(selection)
    .filter(([, on]) => on)
    .map(([key]) => key);

/** What the rows' count and pages are, kept from 1 as Pagination counts. */
const pagesFor = <Row>(props: DataTableProps<Row>, page: number) => {
  const total = props.server?.rowCount;
  // Without a page size there are no pages: every row shows, group headings and opened rows too.
  const size = props.pageSize ?? Number.MAX_SAFE_INTEGER;
  const pagesBefore = Math.max(
    1,
    Math.ceil((total ?? props.rows.length) / size)
  );
  const pageNow = Math.min(page, pagesBefore);
  return {
    total,
    pageNow,
    pagination: { pageIndex: pageNow - 1, pageSize: size },
  };
};

const useTanStack = <Row extends RowData>(
  props: DataTableProps<Row>,
  own: OwnState,
  flags: Flags,
  narrowest: number
) => {
  const { total, pageNow, pagination } = pagesFor(props, own.page);
  const sorting = toSorting(own.sort);
  const rowSelection: RowSelectionState = Object.fromEntries(
    own.chosen.map((key) => [key, true])
  );
  const { fieldId } = own.condition;
  const columnFilters =
    isSet(own.condition) && fieldId !== null
      ? [{ id: fieldId, value: own.condition }]
      : [];
  const state = stateFor(own, flags, props.groupBy, {
    sorting,
    globalFilter: own.query,
    pagination,
    rowSelection,
    columnFilters,
  });
  const server = props.server !== undefined;
  const { subRows, rowKey } = props;
  const table = useTable<Features, Row>({
    features: featuresFor(props.pieces ?? noPieces),
    columns: defsFor(props.columns),
    // The rows as given: a copy on every render would make TanStack start over (closing every
    // opened row) and rebuild its row models each time.
    data: props.rows,
    getRowId: (row) => rowKey(row),
    state,
    onSortingChange: (updater: Updater<SortingState>) => {
      own.setSort(fromSorting(functionalUpdate(updater, sorting)));
    },
    onGlobalFilterChange: (updater: Updater<string>) => {
      own.setQuery(functionalUpdate(updater, own.query));
    },
    onPaginationChange: (updater: Updater<PaginationState>) => {
      own.setPage(functionalUpdate(updater, pagination).pageIndex + 1);
    },
    onRowSelectionChange: (updater: Updater<RowSelectionState>) => {
      own.setChosen(keysOn(functionalUpdate(updater, rowSelection)));
    },
    onColumnVisibilityChange: (updater) => {
      own.setVisibility((now) => functionalUpdate(updater, now));
    },
    onColumnOrderChange: (updater) => {
      own.setOrder((now) => functionalUpdate(updater, now));
    },
    onColumnPinningChange: (updater) => {
      own.setPinned((now) => functionalUpdate(updater, now));
    },
    onColumnSizingChange: (updater) => {
      own.setWidths((now) => functionalUpdate(updater, now));
    },
    onExpandedChange: (updater) => {
      own.setExpanded((now) => functionalUpdate(updater, now));
    },
    getSubRows:
      subRows === undefined ? undefined : (row) => [...(subRows(row) ?? [])],
    getRowCanExpand: props.detail === undefined ? undefined : () => true,
    groupedColumnMode: false,
    columnResizeMode: "onChange",
    columnResizeDirection: "ltr",
    defaultColumn: { minSize: narrowest },
    globalFilterFn: (row, id, words: string) =>
      asText(row.getValue(id))
        .toLowerCase()
        .includes(words.trim().toLowerCase()),
    getColumnCanGlobalFilter: () => true,
    enableMultiSort: true,
    enableSortingRemoval: false,
    isMultiSortEvent: pressed,
    isRowRangeSelectionEvent: pressed,
    // What is open and which page shows are the person's: a new sort, search or set of rows keeps
    // them (the page is put back to 1 by the table where it should be).
    autoResetPageIndex: false,
    autoResetExpanded: false,
    manualSorting: server,
    manualFiltering: server,
    manualPagination: server,
    rowCount: total,
  });
  return { table, total, pageNow };
};

/** Where each held column stands, and how wide the sized table is. */
const geometry = <Row extends RowData>(
  layout: ReturnType<typeof arrange<Row>>,
  widthOf: (key: string) => number,
  chooseWidth: number,
  selectable: boolean,
  sized: boolean,
  room: boolean
) => {
  // Held columns need room beside them: where they would take more than half the box (a phone),
  // nothing is held and the whole table scrolls.
  const measured = room && (chooseWidth > 0 || !selectable);
  const choose = selectable ? chooseWidth : 0;
  // Where a held column stands: past the checkboxes and the held columns before it.
  const pinOf = (key: string): TablePin | undefined => {
    if (!measured) {
      return undefined;
    }
    const startIndex = layout.start.findIndex((column) => column.id === key);
    if (startIndex !== -1) {
      const before = layout.start
        .slice(0, startIndex)
        .reduce((sum, column) => sum + widthOf(column.id), 0);
      return {
        side: "start",
        offset: px(choose + before),
        edge: startIndex === layout.start.length - 1,
      };
    }
    const endIndex = layout.end.findIndex((column) => column.id === key);
    if (endIndex !== -1) {
      const after = layout.end
        .slice(endIndex + 1)
        .reduce((sum, column) => sum + widthOf(column.id), 0);
      return { side: "end", offset: px(after), edge: endIndex === 0 };
    }
    return undefined;
  };
  const choosePin: TablePin | undefined =
    layout.start.length > 0 && measured && selectable
      ? { side: "start", offset: px(0), edge: false, above: true }
      : undefined;
  const tableWidth = sized
    ? layout.shown.reduce((sum, column) => sum + widthOf(column.id), 0) + choose
    : undefined;
  return { pinOf, choosePin, tableWidth };
};

/** The model, and the ref of the box it measures (kept apart: a ref is never read in render). */
export const useDataTable = <Row extends RowData>(
  props: DataTableProps<Row>
) => {
  const flags = flagsFor(props);
  const own = useOwnState(props);
  const measure = useMeasure(flags.sizing, own.setWidths);
  const { table, total, pageNow } = useTanStack(
    props,
    own,
    flags,
    measure.narrowest
  );
  const filtered = isSet(own.condition);

  const layout = arrange(table, own, flags);
  const isHeld = (key: string) =>
    layout.start.some((column) => column.id === key) ||
    layout.end.some((column) => column.id === key);
  const selectable = props.selectable === true;
  const sized = flags.sizing && Object.keys(own.widths).length > 0;
  const widthOf = (key: string) => (flags.sizing ? (own.widths[key] ?? 0) : 0);
  const shownKeys = layout.shown.map((column) => column.id);
  const held = [...layout.start, ...layout.end].reduce(
    (sum, column) =>
      sum + (sized ? widthOf(column.id) : (measure.first[column.id] ?? 0)),
    0
  );
  const heldAll =
    held + (layout.start.length > 0 && selectable ? measure.chooseWidth : 0);
  const room = measure.boxWidth === 0 || heldAll <= measure.boxWidth / 2;
  const { pinOf, choosePin, tableWidth } = geometry(
    layout,
    widthOf,
    measure.chooseWidth,
    selectable,
    sized,
    room
  );

  // A column moves past the next column that scrolls with it: one that is held or hidden is not in
  // its way, and stepping over it in the order alone would show as nothing happening.
  const move = (key: string, by: -1 | 1) => {
    const free = layout.shown
      .map((column) => column.id)
      .filter((id) => !isHeld(id));
    const beside = free[free.indexOf(key) + by];
    if (!free.includes(key) || beside === undefined) {
      return;
    }
    const next = own.order.filter((each) => each !== key);
    next.splice(next.indexOf(beside) + (by === 1 ? 1 : 0), 0, key);
    table.setColumnOrder(next);
  };
  const drop = (from: string, onto: string, side: "before" | "after") => {
    if (from === onto) {
      return;
    }
    const next = own.order.filter((each) => each !== from);
    next.splice(next.indexOf(onto) + (side === "after" ? 1 : 0), 0, from);
    table.setColumnOrder(next);
  };

  const metaOf = (key: string) =>
    props.columns.find((column) => column.key === key);
  const [first] = props.columns;
  // State is read from here, never through a row's or a column's own methods: TanStack keeps those
  // objects as they are while their state changes, so a component given one would not know.
  const sortAt = (key: string) =>
    own.sort.findIndex((each) => each.key === key);
  const reads = {
    isChosen: (key: string) => own.chosen.includes(key),
    // Open is TanStack's own answer (which knows how a group closes out of "all open"), asked
    // through the table, whose reference `useTable` renews on every change.
    isOpen: (key: string) =>
      flags.expanding ? table.getRow(key, true).getIsExpanded() : false,
    sortOf: (key: string) => own.sort[sortAt(key)]?.order,
    sortPlace: (key: string) => sortAt(key) + 1,
    pinnedAt: (key: string) => {
      if ((own.pinned.start ?? []).includes(key)) {
        return "start" as const;
      }
      return (own.pinned.end ?? []).includes(key) ? ("end" as const) : false;
    },
    isVisible: (key: string) => own.visibility[key] ?? true,
    resizing: flags.resizing
      ? table.state.columnResizing.isResizingColumn
      : false,
  };
  const name = (row: TableRowOf<Row>) =>
    first === undefined ? row.id : String(first.value(row.original));

  const model = {
    ...reads,
    table,
    own,
    flags,
    firstWidths: measure.first,
    narrowest: measure.narrowest,
    step: measure.step,
    chooseWidth: measure.chooseWidth,
    shown: layout.shown,
    shownKeys,
    holds: room && layout.start.length + layout.end.length > 0,
    sized,
    widthOf,
    pinOf,
    choosePin,
    tableWidth,
    move,
    drop,
    metaOf,
    name,
    filtered,
    pageNow,
    total,
    span:
      layout.shown.length +
      (selectable ? 1 : 0) +
      (props.rowActions === undefined ? 0 : 1),
  };
  return { model, holder: measure.holder };
};
