// The Data table's features beyond sorting, searching, selecting and pages, each a plain constant a
// table imports only when it uses it, so a bundle leaves out the TanStack code no table needs. Also
// here, as they run without React: where a table's view lives in a link, and its CSV export.
//
//   import { DataTable, columnVisibilityFeature, columnResizingFeature } from "@grasp-os/ui/components/data-table";
//   <DataTable features={[columnVisibilityFeature, columnResizingFeature]} ... />
import {
  columnFilteringFeature,
  columnGroupingFeature,
  columnOrderingFeature as orderingFeature,
  columnPinningFeature as pinningFeature,
  columnResizingFeature as resizingFeature,
  columnSizingFeature,
  columnVisibilityFeature as visibilityFeature,
  createExpandedRowModel,
  createFilteredRowModel,
  createGroupedRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowExpandingFeature as expandingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
} from "@tanstack/react-table";

import { csvOf, saveFile } from "../../lib/utils";

/** One feature a table takes beyond its own: the TanStack features it registers, by name. */
export interface DataTableFeature {
  /** Its name, unique among features ("resizing"). */
  readonly name: string;
  /** The TanStack features and row models it registers, prerequisites first. */
  readonly features: Readonly<Record<string, unknown>>;
}

/** A View menu that hides and shows columns, and Hide in each column's menu. */
export const columnVisibilityFeature: DataTableFeature = {
  name: "view",
  features: { columnVisibilityFeature: visibilityFeature },
};

/**
 * Columns that keep their widths and can be made wider or narrower: by the handle at a head's end
 * (dragged, or focused and moved with the arrow keys), and back to its first width by a double press.
 */
export const columnResizingFeature: DataTableFeature = {
  name: "resizing",
  features: { columnSizingFeature, columnResizingFeature: resizingFeature },
};

/** Columns that can be moved: by dragging a head, or by Move earlier and Move later in its menu. */
export const columnOrderingFeature: DataTableFeature = {
  name: "ordering",
  features: { columnOrderingFeature: orderingFeature },
};

/** Columns held at the start or the end while the rest scroll sideways, from each column's menu. */
export const columnPinningFeature: DataTableFeature = {
  name: "pinning",
  features: { columnSizingFeature, columnPinningFeature: pinningFeature },
};

/** Rows that open: a detail under the row (`renderDetailPanel`), or rows of their own (`getSubRows`). */
export const rowExpandingFeature: DataTableFeature = {
  name: "expanding",
  features: {
    rowExpandingFeature: expandingFeature,
    expandedRowModel: createExpandedRowModel(),
  },
};

/** Rows gathered under a heading row per value of one column (`groupBy`), each with its count. */
export const groupingFeature: DataTableFeature = {
  name: "grouping",
  features: {
    columnGroupingFeature,
    rowExpandingFeature: expandingFeature,
    groupedRowModel: createGroupedRowModel(),
    expandedRowModel: createExpandedRowModel(),
  },
};

// Every feature, as a type alone: a table carries only its own at run time, and reads a feature's
// API only while it holds that feature (`has`). Built at run time, it would bring every row model.
export interface Features {
  rowSortingFeature: typeof rowSortingFeature;
  columnFilteringFeature: typeof columnFilteringFeature;
  globalFilteringFeature: typeof globalFilteringFeature;
  rowSelectionFeature: typeof rowSelectionFeature;
  rowPaginationFeature: typeof rowPaginationFeature;
  columnVisibilityFeature: typeof visibilityFeature;
  columnSizingFeature: typeof columnSizingFeature;
  columnResizingFeature: typeof resizingFeature;
  columnOrderingFeature: typeof orderingFeature;
  columnPinningFeature: typeof pinningFeature;
  columnGroupingFeature: typeof columnGroupingFeature;
  rowExpandingFeature: typeof expandingFeature;
  filteredRowModel: ReturnType<typeof createFilteredRowModel>;
  sortedRowModel: ReturnType<typeof createSortedRowModel>;
  groupedRowModel: ReturnType<typeof createGroupedRowModel>;
  expandedRowModel: ReturnType<typeof createExpandedRowModel>;
  paginatedRowModel: ReturnType<typeof createPaginatedRowModel>;
}

const base = {
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowSelectionFeature,
  rowPaginationFeature,
};
const models = {
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
};

// TanStack wants a features object that does not change while the table lives: one per set of
// features (in the order given), made once.
const made = new Map<string, Features>();
const isModel = ([name]: [string, unknown]) => name.endsWith("RowModel");
// The base is always there, so the built object holds every feature a table reads.
const holdsBase = (features: object): features is Features =>
  [...Object.keys(base), ...Object.keys(models)].every(
    (name) => name in features
  );

export const featuresFor = (list: readonly DataTableFeature[]): Features => {
  const key = list.map((feature) => feature.name).join(" ");
  const known = made.get(key);
  if (known !== undefined) {
    return known;
  }
  const extra = list.flatMap((feature) => Object.entries(feature.features));
  // Feature modules first, row models after their prerequisites.
  const built = {
    ...base,
    ...Object.fromEntries(extra.filter((entry) => !isModel(entry))),
    ...models,
    ...Object.fromEntries(extra.filter(isModel)),
  };
  if (!holdsBase(built)) {
    throw new Error("DataTable: its base features are missing.");
  }
  made.set(key, built);
  return built;
};

export const has = (list: readonly DataTableFeature[], name: string) =>
  list.some((feature) => feature.name === name);

// ---- The view in a link --------------------------------------------------------------------------

/** What a link remembers of a table's view. Each part is left out while it is as the table starts. */
export interface DataTableView {
  /** The order, the first column deciding most. */
  sort?: { key: string; order: "ascending" | "descending" }[];
  /** What the search holds. */
  query?: string;
  /** The filter's condition. */
  filter?: { field: string; operator: string; value: string | number };
  /** The page shown, from 1. */
  page?: number;
  /** The columns hidden, by id. */
  hidden?: string[];
  /** Every column's id, in the order shown. */
  order?: string[];
  /** The columns held at the start and at the end, by id. */
  pinned?: { start: string[]; end: string[] };
  /** The groups collapsed, by their value, with `groupingFeature`. */
  collapsed?: string[];
}

/** Reads and writes a table's view, so a link reopens it as it was. */
export interface DataTableLocation {
  read: () => DataTableView;
  /** Writes the view without a new history entry: a sort or a search is not a place to go Back to. */
  write: (view: DataTableView) => void;
  /** Runs when the view changes from outside: Back, Forward, a link. Returns a stop. */
  listen: (change: () => void) => () => void;
}

const list = (text: string | null | undefined) =>
  text === null || text === undefined || text === ""
    ? undefined
    : text.split(",").filter((each) => each !== "");

const valueOf = (text: string) => {
  const number = Number(text);
  return text.trim() !== "" && Number.isFinite(number) ? number : text;
};

/**
 * The view in the query string: `?<prefix>-sort=owner,-pages&<prefix>-q=plan`,
 * `<prefix>-filter=owner.is.Sam%20Patel`, `<prefix>-page=2`, `<prefix>-hide=words`,
 * `<prefix>-order=name,team,owner`, `<prefix>-pin=name|status` (start, then end) and
 * `<prefix>-closed=Running,Sketched` (each value encoded, so a value may hold a comma).
 */
export const searchParamsLocation = (prefix = "table"): DataTableLocation => {
  const key = (name: string) => `${prefix}-${name}`;
  return {
    read: () => {
      if (typeof window === "undefined") {
        return {};
      }
      const params = new URLSearchParams(window.location.search);
      const view: DataTableView = {
        hidden: list(params.get(key("hide"))),
        order: list(params.get(key("order"))),
      };
      const sort = list(params.get(key("sort")));
      if (sort !== undefined) {
        view.sort = sort.map((each) =>
          each.startsWith("-")
            ? { key: each.slice(1), order: "descending" }
            : { key: each, order: "ascending" }
        );
      }
      const query = params.get(key("q"));
      if (query !== null && query !== "") {
        view.query = query;
      }
      const [field = "", operator = "", ...rest] = (
        params.get(key("filter")) ?? ""
      ).split(".");
      const value = rest.join(".");
      if (field !== "" && operator !== "" && value !== "") {
        view.filter = { field, operator, value: valueOf(value) };
      }
      const page = Number(params.get(key("page")));
      if (Number.isInteger(page) && page > 1) {
        view.page = page;
      }
      const pin = params.get(key("pin"));
      if (pin !== null && pin !== "") {
        const [start, end] = pin.split("|");
        view.pinned = { start: list(start) ?? [], end: list(end) ?? [] };
      }
      const closed = list(params.get(key("closed")));
      if (closed !== undefined) {
        view.collapsed = closed.map((each) => decodeURIComponent(each));
      }
      return view;
    },
    write: (view) => {
      const url = new URL(window.location.href);
      const set = (name: string, value: string | undefined) => {
        if (value === undefined || value === "") {
          url.searchParams.delete(key(name));
        } else {
          url.searchParams.set(key(name), value);
        }
      };
      const { filter, pinned } = view;
      set(
        "sort",
        view.sort
          ?.map((each) =>
            each.order === "descending" ? `-${each.key}` : each.key
          )
          .join(",")
      );
      set("q", view.query);
      set(
        "filter",
        filter && `${filter.field}.${filter.operator}.${String(filter.value)}`
      );
      set("page", (view.page ?? 1) > 1 ? String(view.page) : undefined);
      set("hide", view.hidden?.join(","));
      set("order", view.order?.join(","));
      set(
        "pin",
        pinned === undefined || pinned.start.length + pinned.end.length === 0
          ? undefined
          : `${pinned.start.join(",")}|${pinned.end.join(",")}`
      );
      set("closed", view.collapsed?.map(encodeURIComponent).join(","));
      if (url.href !== window.location.href) {
        window.history.replaceState(window.history.state, "", url);
      }
    },
    listen: (change) => {
      window.addEventListener("popstate", change);
      return () => {
        window.removeEventListener("popstate", change);
      };
    },
  };
};

// ---- Export --------------------------------------------------------------------------------------

/**
 * The head and the rows as CSV (csvOf), after UTF-8's byte-order mark: without it, Excel reads the
 * file in the machine's own code page and garbles any letter outside ASCII ("Zoë", "東京").
 */
export const toCsv = (
  head: readonly string[],
  rows: readonly (readonly (string | number)[])[]
) => `\uFEFF${csvOf([head, ...rows])}`;

/** Saves the text as a CSV file of that name, which the browser downloads. */
export const saveCsv = (text: string, name: string) => {
  saveFile(
    text,
    name.endsWith(".csv") ? name : `${name}.csv`,
    "text/csv;charset=utf-8"
  );
};
