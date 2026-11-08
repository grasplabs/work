import { identifierMaxLength } from "@grasp-os/shared/identifier";
import { rangeShapeIssue } from "@grasp-os/shared/store-reads";

import { tablesOf } from "./define-schema.ts";
import { rangeOf, ranges } from "./index-range.ts";
import { queryOf } from "./query-builder.ts";
import type {
  QueryState,
  ReadExecutor,
  RuntimeQuery,
} from "./query-builder.ts";
import { refuse } from "./query-error.ts";
import type { Query, SearchQuery } from "./query-reads.ts";
import { searchTextOf } from "./query-terminals.ts";
import type {
  AnyTables,
  Doc,
  IndexesOf,
  IndexFields,
  IndexRange,
  IndexRangeBuilder,
} from "./query-types.ts";
import type { AnyTable, SchemaDefinition, TableState } from "./schema-types.ts";
import type { Id } from "./value-types.ts";

// `ctx.db` for reading: a record by ID, and queries over a table, typed by
// the App's schema. It is a facade and holds no authority: every read is
// one request (`ReadRequest`) handed to the invocation's executor, which
// the trusted host supplies, and the host decides what the caller may see.
//
// A query is built as a value: each modifier answers a new query, and
// nothing is read until a terminal is called. Building one checks it
// against the schema (a table, index, field or range it doesn't have is
// refused here, with a `QueryDefinitionError`), and the host checks the
// descriptor again, trusting nothing from here. The descriptor names
// tables, indexes and fields as the schema does; it never holds SQL, a
// physical ID, an owner or a role.
//
// Every terminal is bounded as Convex's are, by what it reads: one read
// examines at most 10,000 index entries and 16 MiB of documents
// (`data.scan_limit` past them, never a part), whatever it answers. So
// `collect` answers every record a read may reach, and longer lists page,
// through a table of any size, each page bounded on its own; large
// exports and aggregates are a workflow's.
//
// Besides queries: `search(table, text)` reads a table's full-text search
// index in order of relevance; `group` counts and aggregates per value of
// one or more fields; `with` loads the records a query's `v.id` fields
// name, under the caller's access to their tables.
//
// Adapted from Baseflare's query builder and structured filters (MIT,
// © 2026 Baseflare contributors: packages/baseflare/src/server/db), with
// Convex-style index ranges and Grasp's bounds.

/** A query of one table, before an index is chosen. */
type QueryInitializer<
  Table extends AnyTable,
  TableName extends string,
  Tables extends AnyTables = AnyTables,
> = Query<Doc<Table, TableName>, false, Tables> & {
  /**
   * Reads through index `name`, in its order, within the range `range`
   * builds: equality on its first fields, then a lower and/or upper bound
   * on the next. Ordered by its fields, any page of it is as cheap as the
   * first.
   */
  readonly withIndex: <const Name extends keyof IndexesOf<Table> & string>(
    name: Name,
    range?: (
      range: IndexRangeBuilder<Doc<Table, TableName>, IndexFields<Table, Name>>
    ) => IndexRange
  ) => Query<Doc<Table, TableName>, false, Tables>;
};

/** The tables of a schema that declare a search index. */
type SearchableTable<Tables extends AnyTables> = {
  [TableName in keyof Tables & string]: Tables[TableName] extends {
    readonly "~searchable"?: infer Searchable;
  }
    ? true extends Searchable
      ? TableName
      : never
    : never;
}[keyof Tables & string];

/** `ctx.db` for reading, typed by a schema's tables. */
export interface DatabaseReader<Tables extends AnyTables> {
  /**
   * Record `id` of `table`, or null when there is none the caller may
   * see: which of the two is never told apart.
   */
  readonly get: <TableName extends keyof Tables & string>(
    table: TableName,
    id: Id<NoInfer<TableName>>
  ) => Promise<Doc<Tables[TableName], TableName> | null>;
  /** A query of `table`; nothing is read until a terminal is called. */
  readonly query: <TableName extends keyof Tables & string>(
    table: TableName
  ) => QueryInitializer<Tables[TableName], TableName, Tables>;
  /**
   * A search of `table`'s search index (`.searchIndex` in the schema) for
   * `text`: records holding every word of it in the indexed fields (the
   * last word as a prefix, so a search box finds as its person types,
   * case and accents ignored), best match first. At most 8 words and 256
   * characters; text with no words finds nothing. The table's matches are
   * ranked within the host's scan bound: a word so common it matches more
   * fails (`data.scan_limit`), so narrow the text. Nothing is read until a
   * terminal is called.
   *
   * ```ts
   * const page = await ctx.db
   *   .search("customers", args.text)
   *   .filter({ archived: false })
   *   .paginate(args.pagination);
   * ```
   */
  readonly search: <TableName extends SearchableTable<Tables>>(
    table: TableName,
    text: string
  ) => SearchQuery<Doc<Tables[TableName], TableName>, Tables>;
}

/** Whether `value` is a function, to be called with a range. */
const isRangeFunction = (
  value: unknown
): value is (range: IndexRange) => unknown => typeof value === "function";

/** The reader as this module builds it, taking anything. */
interface RuntimeReader {
  readonly get: (
    table: unknown,
    id: unknown,
    ...rest: unknown[]
  ) => Promise<unknown>;
  readonly query: (table: unknown) => RuntimeQuery & {
    readonly withIndex: (index: unknown, build?: unknown) => RuntimeQuery;
  };
  readonly search: (table: unknown, text: unknown) => RuntimeQuery;
}

/**
 * `ctx.db` for reading `schema`'s tables, each read run by `execute`. The
 * host builds one per invocation; App code never chooses `execute`.
 */
export const databaseReader = <Tables extends AnyTables>(
  schema: SchemaDefinition<Tables>,
  execute: ReadExecutor
): DatabaseReader<Tables> => {
  const states = tablesOf(schema);
  const stateOf = (table: unknown): { name: string; state: TableState } => {
    const state =
      typeof table === "string" && Object.hasOwn(states, table)
        ? states[table]
        : undefined;
    if (typeof table !== "string" || state === undefined) {
      return refuse("query.unknown_table", "The schema has no such table.");
    }
    return { name: table, state };
  };
  const reader: RuntimeReader = {
    get: async (table: unknown, id: unknown, ...rest: unknown[]) => {
      const { name } = stateOf(table);
      if (rest.length > 0) {
        return refuse(
          "query.invalid_terminal",
          "`get` takes a table and a record ID, and nothing else."
        );
      }
      if (
        typeof id !== "string" ||
        id === "" ||
        id.length > identifierMaxLength
      ) {
        return refuse("query.invalid_terminal", "`get` takes a record ID.");
      }
      return await execute({
        kind: "get",
        table: name,
        id,
      });
    },
    query: (table: unknown) => {
      const { name, state } = stateOf(table);
      const base: QueryState = {
        table: name,
        state,
        index: null,
        range: [],
        filters: [],
        order: "asc",
        ordered: false,
        search: undefined,
        related: [],
      };
      return Object.freeze({
        ...queryOf(base, execute),
        withIndex: (index: unknown, build?: unknown) => {
          const declared =
            typeof index === "string"
              ? state.indexes.find(({ name: indexName }) => indexName === index)
              : undefined;
          if (declared === undefined) {
            return refuse(
              "query.unknown_index",
              `Table \`${name}\` has no such index.`
            );
          }
          if (build === undefined) {
            return queryOf({ ...base, index: declared.name }, execute);
          }
          if (!isRangeFunction(build)) {
            return refuse(
              "query.invalid_range",
              "An index range is built by a function of the range."
            );
          }
          const owner = declared;
          const built = build(
            rangeOf({
              owner,
              table: state,
              fields: declared.fields,
              bounds: [],
              lowerOn: null,
              ended: false,
            })
          );
          const recorded =
            typeof built === "object" && built !== null
              ? ranges.get(built)
              : undefined;
          if (recorded === undefined || recorded.owner !== owner) {
            return refuse(
              "query.invalid_range",
              "An index range's function returns the range it built, for this index."
            );
          }
          const issue = rangeShapeIssue(recorded.bounds);
          if (issue !== undefined) {
            return refuse("query.invalid_range", `${issue}.`);
          }
          return queryOf(
            { ...base, index: declared.name, range: recorded.bounds },
            execute
          );
        },
      });
    },
    search: (table: unknown, text: unknown) => {
      const { name, state } = stateOf(table);
      if (state.searchIndex === undefined) {
        return refuse(
          "query.unknown_index",
          `Table \`${name}\` has no search index: declare one with \`.searchIndex([...fields])\`.`
        );
      }
      return queryOf(
        {
          table: name,
          state,
          index: null,
          range: [],
          filters: [],
          order: "asc",
          ordered: true,
          search: searchTextOf(text),
          related: [],
        },
        execute
      );
    },
  };
  // SAFETY: each method checks at run time what `DatabaseReader` types (a
  // table, index, range, filter or terminal of the schema), and answers
  // what the host returns for the request it was built into, which the
  // host shapes as `Doc` of the pinned schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return Object.freeze(reader) as DatabaseReader<Tables>;
};
