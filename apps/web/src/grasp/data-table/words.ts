// Every word a Data table shows or says, so a product can put them in its own language. Each has an
// English default. The product gives them in its languages through GraspWords (src/words), as the
// catalogue's `dataTable` and `dataTableFilters`; a caller's `words`, `filterWords` and `unit` still
// win until the breaking release's step 5. `one` and `many` are the table's `unit`.
import type { DataTableUnit } from "./types";

/** The words of a Data table. */
export interface DataTableWords {
  /**
   * The search's placeholder: "Search reports".
   * @default Search {many}
   */
  search: (many: string) => string;
  /**
   * The search's name, from the table's label: "Search reports".
   * @default Search {label.toLowerCase()}
   */
  searchLabel: (label: string) => string;
  /**
   * The search's clear button.
   * @default Clear search
   */
  clearSearch: string;
  /**
   * The Filter builder's name: "Filter reports".
   * @default Filter {label.toLowerCase()}
   */
  filterLabel: (label: string) => string;
  /**
   * The count of chosen rows: "2 of 9 chosen".
   * @default {count} of {total} chosen
   */
  chosen: (count: number, total: number) => string;
  /**
   * The head's checkbox: "Choose every report shown".
   * @default Choose every {one} shown
   */
  chooseAll: (one: string) => string;
  /**
   * A row's checkbox: "Choose Quarterly summary".
   * @default Choose {name}
   */
  choose: (name: string) => string;
  /**
   * The checkboxes' column.
   * @default Choose
   */
  chooseColumn: string;
  /**
   * The bar while rows are chosen: "With the chosen reports".
   * @default With the chosen {many}
   */
  withChosen: (many: string) => string;
  /**
   * Clears the choice.
   * @default Clear
   */
  clear: string;
  /**
   * Said once an action is done: "Archive: 2 reports".
   * @default {action}: {count} {unit}
   */
  done: (action: string, count: number, unit: string) => string;
  /**
   * Undoes it, in the toast.
   * @default Undo
   */
  undo: string;
  /**
   * A grave action's question, when it brings none: "Delete 2 reports?".
   * @default {action} {count} {unit}?
   */
  confirm: (action: string, count: number, unit: string) => string;
  /**
   * What a grave action's question says will happen, when it brings none.
   * @default This cannot be undone.
   */
  confirmDetail: string;
  /**
   * Keeps the rows as they are, in the question.
   * @default Cancel
   */
  cancel: string;
  /**
   * The View menu.
   * @default View
   */
  view: string;
  /**
   * The View menu's list of columns.
   * @default Columns
   */
  columns: string;
  /**
   * A column's menu: "Column: Owner".
   * @default Column: {header}
   */
  columnMenu: (header: string) => string;
  /**
   * @default Sort low to high
   */
  sortUp: string;
  /**
   * @default Sort high to low
   */
  sortDown: string;
  /**
   * Adds the column to the sort, after the others.
   * @default Sort by this next
   */
  sortNext: string;
  /**
   * @default Pin to the start
   */
  pinStart: string;
  /**
   * @default Pin to the end
   */
  pinEnd: string;
  /**
   * @default Unpin
   */
  unpin: string;
  /**
   * @default Move earlier
   */
  moveEarlier: string;
  /**
   * @default Move later
   */
  moveLater: string;
  /**
   * @default Hide column
   */
  hide: string;
  /**
   * A column's resize handle: "Width of Owner".
   * @default Width of {header}
   */
  width: (header: string) => string;
  /**
   * A sorted head's place in a sort by several: ", sorted second".
   * @default , sorted {first, second, third, fourth, fifth, then 6th}
   */
  sortedPlace: (place: number) => string;
  /**
   * @default Export CSV
   */
  exportCsv: string;
  /**
   * The row actions' column.
   * @default Actions
   */
  actions: string;
  /**
   * A row's actions menu: "Actions for Quarterly summary".
   * @default Actions for {name}
   */
  actionsFor: (name: string) => string;
  /**
   * A row or a group's toggle: "Open Quarterly summary".
   * @default Open {name}
   */
  open: (name: string) => string;
  /**
   * @default Close {name}
   */
  close: (name: string) => string;
  /**
   * No rows yet: "No reports yet."
   * @default No {many} yet.
   */
  noneYet: (many: string) => string;
  /**
   * The search found none: "No reports match “plan”."
   * @default No {many} match “{query}”.
   */
  noMatch: (many: string, query: string) => string;
  /**
   * The filter found none.
   * @default No {many} meet the filter.
   */
  noneMeet: (many: string) => string;
  /**
   * Said while the rows load: "Loading reports".
   * @default Loading {many}
   */
  loading: (many: string) => string;
  /**
   * @default Loading more {many}
   */
  loadingMore: (many: string) => string;
  /**
   * The rows did not load: "The reports did not load".
   * @default The {many} did not load
   */
  failed: (many: string) => string;
  /**
   * @default Check the connection, then try again.
   */
  failedDetail: string;
  /**
   * @default Try again
   */
  tryAgain: string;
  /**
   * The pages' name: "Pages of reports".
   * @default Pages of {label.toLowerCase()}
   */
  pages: (label: string) => string;
}

const places = ["first", "second", "third", "fourth", "fifth"];

export const englishWords: DataTableWords = {
  search: (many) => `Search ${many}`,
  searchLabel: (label) => `Search ${label.toLowerCase()}`,
  clearSearch: "Clear search",
  filterLabel: (label) => `Filter ${label.toLowerCase()}`,
  chosen: (count, total) => `${count} of ${total} chosen`,
  chooseAll: (one) => `Choose every ${one} shown`,
  choose: (name) => `Choose ${name}`,
  chooseColumn: "Choose",
  withChosen: (many) => `With the chosen ${many}`,
  clear: "Clear",
  done: (action, count, unit) => `${action}: ${count} ${unit}`,
  undo: "Undo",
  confirm: (action, count, unit) => `${action} ${count} ${unit}?`,
  confirmDetail: "This cannot be undone.",
  cancel: "Cancel",
  view: "View",
  columns: "Columns",
  columnMenu: (header) => `Column: ${header}`,
  sortUp: "Sort low to high",
  sortDown: "Sort high to low",
  sortNext: "Sort by this next",
  pinStart: "Pin to the start",
  pinEnd: "Pin to the end",
  unpin: "Unpin",
  moveEarlier: "Move earlier",
  moveLater: "Move later",
  hide: "Hide column",
  width: (header) => `Width of ${header}`,
  sortedPlace: (place) => `, sorted ${places[place - 1] ?? `${place}th`}`,
  exportCsv: "Export CSV",
  actions: "Actions",
  actionsFor: (name) => `Actions for ${name}`,
  open: (name) => `Open ${name}`,
  close: (name) => `Close ${name}`,
  noneYet: (many) => `No ${many} yet.`,
  noMatch: (many, query) => `No ${many} match “${query}”.`,
  noneMeet: (many) => `No ${many} meet the filter.`,
  loading: (many) => `Loading ${many}`,
  loadingMore: (many) => `Loading more ${many}`,
  failed: (many) => `The ${many} did not load`,
  failedDetail: "Check the connection, then try again.",
  tryAgain: "Try again",
  pages: (label) => `Pages of ${label.toLowerCase()}`,
};

/** The Filter builder's operators' words, so a product can translate them. */
export interface DataTableFilterWords {
  /**
   * @default contains
   */
  contains: string;
  /**
   * @default does not contain
   */
  lacks: string;
  /**
   * @default is at least
   */
  atLeast: string;
  /**
   * @default is at most
   */
  atMost: string;
  /**
   * @default is
   */
  is: string;
  /**
   * @default is not
   */
  isNot: string;
}

export const englishFilterWords: DataTableFilterWords = {
  contains: "contains",
  lacks: "does not contain",
  atLeast: "is at least",
  atMost: "is at most",
  is: "is",
  isNot: "is not",
};

/** The table's words in the catalogue: its own, and what it counts when no `unit` is given. */
export const dataTableWords = {
  ...englishWords,
  rows: { one: "row", other: "rows" } satisfies DataTableUnit,
};

export type DataTableCatalogueWords = typeof dataTableWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    dataTable: DataTableCatalogueWords;
    dataTableFilters: DataTableFilterWords;
  }
}

/**
 * What the table's agent tools answer when they cannot do what was asked. For the agent, which reads
 * English: kept here with the words, and not in the catalogue, as no person reads them.
 */
export const agentErrors = {
  noSort: (key: string, sortable: string[]) =>
    `No sortable column "${key}". Sortable: ${sortable.join(", ")}.`,
  noSearch: "This table has no search.",
  noFilter: "This table has no filter.",
  noField: (field: string, fields: string[]) =>
    `No filter on "${field}". Fields: ${fields.join(", ")}.`,
  noOperator: (operator: string, field: string, operators: string[]) =>
    `"${operator}" is not an operator of ${field}: ${operators.join(", ")}.`,
  noChoosing: "Rows cannot be chosen in this table.",
  noRows: (keys: readonly string[]) =>
    `No rows with the keys ${keys.join(", ")}.`,
  pages: (count: number) => `There are pages 1 to ${String(count)}.`,
};
