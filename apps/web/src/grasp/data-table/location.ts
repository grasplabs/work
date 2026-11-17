// Where a Data table's view lives, so a link reopens it as it was: the sort, the search, the
// filter, the page, and which columns show, in what order, held where. One small adapter, as the
// Artifact viewer's: the default keeps it in the query string under the table's own prefix, and a
// product can pass its own router's instead.

/** What a link remembers of a table's view. Each part is left out while it is as the table starts. */
export interface DataTableView {
  /** The order, the first column deciding most. */
  sort?: { key: string; order: "ascending" | "descending" }[];
  /** What the search holds. */
  query?: string;
  /** The Filter builder's condition. */
  filter?: { field: string; operator: string; value: string | number };
  /** The page shown, from 1. */
  page?: number;
  /** The columns hidden, by key. */
  hidden?: string[];
  /** Every column's key, in the order shown. */
  order?: string[];
  /** The columns held at the start and at the end, by key. */
  pinned?: { start: string[]; end: string[] };
}

/** Reads and writes a table's view. */
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

const sortOf = (each: string) =>
  each.startsWith("-")
    ? { key: each.slice(1), order: "descending" as const }
    : { key: each, order: "ascending" as const };

/**
 * The view in the query string: `?<prefix>-sort=owner,-pages&<prefix>-q=plan&<prefix>-filter=owner.is.Sam%20Patel`,
 * `<prefix>-page=2`, `<prefix>-hide=words`, `<prefix>-order=name,team,owner`,
 * `<prefix>-pin=name|status` (start, then end).
 */
export const queryLocation = (prefix = "table"): DataTableLocation => {
  const key = (name: string) => `${prefix}-${name}`;
  return {
    read: () => {
      if (typeof window === "undefined") {
        return {};
      }
      const params = new URLSearchParams(window.location.search);
      const view: DataTableView = {};
      const sort = list(params.get(key("sort")));
      if (sort !== undefined) {
        view.sort = sort.map(sortOf);
      }
      const query = params.get(key("q"));
      if (query !== null && query !== "") {
        view.query = query;
      }
      const [field, operator, ...rest] = (
        params.get(key("filter")) ?? ""
      ).split(".");
      const value = rest.join(".");
      if (
        field !== undefined &&
        field !== "" &&
        operator !== undefined &&
        operator !== "" &&
        value !== ""
      ) {
        view.filter = { field, operator, value: valueOf(value) };
      }
      const page = Number(params.get(key("page")));
      if (Number.isInteger(page) && page > 1) {
        view.page = page;
      }
      view.hidden = list(params.get(key("hide")));
      view.order = list(params.get(key("order")));
      const pin = params.get(key("pin"));
      if (pin !== null && pin !== "") {
        const [start, end] = pin.split("|");
        view.pinned = { start: list(start) ?? [], end: list(end) ?? [] };
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
        view.filter === undefined
          ? undefined
          : `${view.filter.field}.${view.filter.operator}.${String(view.filter.value)}`
      );
      set(
        "page",
        view.page !== undefined && view.page > 1 ? String(view.page) : undefined
      );
      set("hide", view.hidden?.join(","));
      set("order", view.order?.join(","));
      const { pinned } = view;
      set(
        "pin",
        pinned === undefined || pinned.start.length + pinned.end.length === 0
          ? undefined
          : `${pinned.start.join(",")}|${pinned.end.join(",")}`
      );
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
