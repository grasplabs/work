// The Data table as an agent sees it, through the page's one agent bridge (UI SDK's createAgent):
// a part named after the table, whose actions read its columns and rows and change the view. The
// actions are the table's own functions, handed in as an option, so they always act on the table
// as it is now. The rows' checkboxes, the bar's actions and the menus are UI SDK parts the bridge
// sees anyway; a danger action waits for the person, as every danger Button does.
//
//   await agent.act({ steps: [{ ref: "Reports", action: "read" }] })
//   await agent.act({ steps: [{ ref: "Reports", action: "sortBy", args: [{ key: "pages", order: "descending" }] }] })
import { definePrimitive } from "@ui-sdk/core";

/** What an agent may ask of a Data table. Each answers with plain data, or `{ error }`. */
export interface DataTableTools {
  /** The columns, and the rows found (every page), from `offset`, at most 200, with the view. */
  read: (input?: { offset?: number }) => unknown;
  /** Sorts by a column, or adds it to the sort with `add`. */
  sortBy: (input: {
    key: string;
    order?: "ascending" | "descending";
    add?: boolean;
  }) => unknown;
  /** Searches, as the search field does; "" clears it. */
  search: (input: { query: string }) => unknown;
  /** Filters, as the Filter builder does; `null` clears it. */
  filter: (
    input: { field: string; operator: string; value: string | number } | null
  ) => unknown;
  /** Chooses exactly these rows, by key. */
  choose: (input: { keys: string[] }) => unknown;
  /** Shows a page, from 1. */
  page: (input: { page: number }) => unknown;
}

interface Options {
  tools?: DataTableTools;
}

const ask = (
  options: () => Options,
  run: (tools: DataTableTools) => unknown
) => {
  const { tools } = options();
  if (tools === undefined) {
    return { error: "The table is not ready yet." };
  }
  return run(tools);
};

export const dataTableAgent = definePrimitive({
  name: "data-table",
  options: { tools: "value" },
  state: (_options: Options) => ({}),
  api: (context) => ({
    read: (input?: { offset?: number }) =>
      ask(context.options, (tools) => tools.read(input)),
    sortBy: (input: Parameters<DataTableTools["sortBy"]>[0]) =>
      ask(context.options, (tools) => tools.sortBy(input)),
    search: (input: { query: string }) =>
      ask(context.options, (tools) => tools.search(input)),
    filter: (input: Parameters<DataTableTools["filter"]>[0]) =>
      ask(context.options, (tools) => tools.filter(input)),
    choose: (input: { keys: string[] }) =>
      ask(context.options, (tools) => tools.choose(input)),
    page: (input: { page: number }) =>
      ask(context.options, (tools) => tools.page(input)),
  }),
  slots: (slot) => ({
    root: slot({}),
  }),
  agent: { actions: ["read", "sortBy", "search", "filter", "choose", "page"] },
});
