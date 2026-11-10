import {
  boundValuesIssue,
  filterBudgetIssue,
  readDescriptorVersion,
} from "@grasp-os/shared/store-reads";
import type {
  FilterNode,
  QueryRequest,
  QueryTerminal,
  RangeBound,
  ReadRequest,
} from "@grasp-os/shared/store-reads";

import { deepFreeze } from "./declaration.ts";
import { refuse } from "./query-error.ts";
import { filterOf, filterTree, nodeCount } from "./query-filter.ts";
import type { NodeBudget } from "./query-filter.ts";
import {
  aggregateTerminal,
  checkedCount,
  groupTerminal,
  pageTerminal,
  relatedOf,
} from "./query-terminals.ts";
import type { TableState } from "./schema-types.ts";

/**
 * Runs one read for the invocation: supplied by the trusted host, which
 * resolves the caller, the store and the pinned schema itself.
 */
export type ReadExecutor = (request: ReadRequest) => Promise<unknown>;

/** What a query has been given so far. */
export interface QueryState {
  readonly table: string;
  readonly state: TableState;
  readonly index: string | null;
  readonly range: readonly RangeBound[];
  /** Its filters, each `.filter` one more, all of which must hold. */
  readonly filters: readonly FilterNode[];
  readonly order: "asc" | "desc";
  /** Whether `.order` was called: a query is ordered once. */
  readonly ordered: boolean;
  /** The text a search looks for; none for a query. */
  readonly search: string | undefined;
  /** The fields whose related records it loads (`.with`), in order. */
  readonly related: readonly string[];
}

/**
 * A query as this module builds it: the methods `Query` types, taking
 * anything, since App code may call them with anything.
 */
export interface RuntimeQuery {
  readonly filter: (filter: unknown) => RuntimeQuery;
  readonly with: (...fields: unknown[]) => RuntimeQuery;
  readonly order: (direction: unknown) => RuntimeQuery;
  readonly take: (count: unknown) => Promise<unknown>;
  readonly first: () => Promise<unknown>;
  readonly unique: () => Promise<unknown>;
  readonly count: () => Promise<unknown>;
  readonly collect: () => Promise<unknown>;
  readonly paginate: (options: unknown) => Promise<unknown>;
  readonly aggregate: (options: unknown) => Promise<unknown>;
  readonly group: (options: unknown) => Promise<unknown>;
}

/** The terminals that return records, which `.with` and a search take. */
const recordTerminals: ReadonlySet<QueryTerminal["kind"]> = new Set([
  "take",
  "first",
  "unique",
  "collect",
  "paginate",
]);

/** The query `query`, with the modifiers and terminals reading it. */
export const queryOf = (
  query: QueryState,
  execute: ReadExecutor
): RuntimeQuery => {
  const run = async (terminal: QueryTerminal): Promise<unknown> => {
    const filter = filterOf(query.filters);
    const issue = boundValuesIssue(query.range, filter);
    if (issue !== undefined) {
      refuse("query.invalid_filter", `${issue}.`);
    }
    if (query.related.length > 0 && !recordTerminals.has(terminal.kind)) {
      refuse(
        "query.invalid_terminal",
        "`.with` loads related records for a terminal that returns records: `take`, `first`, `unique`, `collect` or `paginate`."
      );
    }
    // A copy of its own for the executor: what it does with it can't
    // change this query or any read after.
    const request: QueryRequest = structuredClone({
      descriptorVersion: readDescriptorVersion,
      table: query.table,
      index: query.index,
      range: [...query.range],
      filter,
      order: query.order,
      terminal,
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.related.length === 0 ? {} : { with: [...query.related] }),
    });
    return await execute({ kind: "query", query: request });
  };
  const searched = query.search !== undefined;
  /** Refuses a terminal or modifier a search doesn't have. */
  const notForSearch = (what: string): void => {
    if (searched) {
      refuse(
        "query.invalid_terminal",
        `A search is read in order of relevance: it has no \`${what}\`.`
      );
    }
  };
  return Object.freeze({
    filter: (filter: unknown) => {
      // The filters so far, and the `and` that holds them once there are
      // two, count against the same budget as the new one.
      const budget: NodeBudget = {
        nodes: nodeCount(query.filters) + (query.filters.length > 0 ? 1 : 0),
      };
      const filters = [
        ...query.filters,
        deepFreeze(filterTree(query.state, filter, 0, budget)),
      ];
      const issue = filterBudgetIssue(filterOf(filters));
      if (issue !== undefined) {
        refuse(
          "query.invalid_filter",
          `${issue}, all of a query's filters together.`
        );
      }
      return queryOf({ ...query, filters }, execute);
    },
    with: (...fields: unknown[]) =>
      queryOf(
        { ...query, related: relatedOf(query.state, query.related, fields) },
        execute
      ),
    order: (direction: unknown) => {
      notForSearch("order");
      if (query.ordered) {
        return refuse("query.invalid_terminal", "A query is ordered once.");
      }
      if (direction !== "asc" && direction !== "desc") {
        return refuse(
          "query.invalid_terminal",
          'A query is ordered `"asc"` or `"desc"`.'
        );
      }
      return queryOf({ ...query, order: direction, ordered: true }, execute);
    },
    take: async (count: unknown) =>
      await run({ kind: "take", count: checkedCount(count, 0, "`take`") }),
    first: async () => await run({ kind: "first" }),
    unique: async () => {
      notForSearch("unique");
      return await run({ kind: "unique" });
    },
    count: async () => await run({ kind: "count" }),
    collect: async () => await run({ kind: "collect" }),
    paginate: async (options: unknown) => await run(pageTerminal(options)),
    aggregate: async (options: unknown) => {
      notForSearch("aggregate");
      return await run(aggregateTerminal(query.state, options));
    },
    group: async (options: unknown) => {
      notForSearch("group");
      return await run(groupTerminal(query.state, options));
    },
  });
};
