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
import { hasOnly } from "./query-values.ts";
import type { AnyTable, SchemaDefinition, TableState } from "./schema-types.ts";
import type { Id } from "./values.ts";

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

/** What `get` may assert. */
interface GetOptions {
  /**
   * The revision the caller expects the record at: a different one fails
   * with `data.conflict`. Applies only to a record the caller may see.
   */
  readonly expectedRevision?: number;
}

/** `ctx.db` for reading, typed by a schema's tables. */
export interface DatabaseReader<Tables extends AnyTables> {
  /**
   * Record `id` of `table`, or null when there is none the caller may
   * see: which of the two is never told apart.
   */
  readonly get: <TableName extends keyof Tables & string>(
    table: TableName,
    id: Id<NoInfer<TableName>>,
    options?: GetOptions
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
    options?: unknown
  ) => Promise<unknown>;
  readonly query: (table: unknown) => RuntimeQuery & {
    readonly withIndex: (index: unknown, build?: unknown) => RuntimeQuery;
  };
  readonly search: (table: unknown, text: unknown) => RuntimeQuery;
}

/** The revision `get`'s options assert, or null; refused unless valid. */
export const expectedRevisionOf = (options: unknown): number | null => {
  if (options === undefined) {
    return null;
  }
  if (!hasOnly(options, ["expectedRevision"])) {
    return refuse(
      "query.invalid_terminal",
      "`get` takes `{ expectedRevision }`, or no options."
    );
  }
  const { expectedRevision } = options;
  if (expectedRevision === undefined) {
    return null;
  }
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    return refuse(
      "query.invalid_terminal",
      "`expectedRevision` is a whole number of at least 1."
    );
  }
  return expectedRevision;
};

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
    get: async (table: unknown, id: unknown, options?: unknown) => {
      const { name } = stateOf(table);
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
        expectedRevision: expectedRevisionOf(options),
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
