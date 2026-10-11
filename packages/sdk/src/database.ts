import {
  filterMaxDepth,
  filterMaxInValues,
  filterMaxNodes,
  queryDefaultPageSize,
  queryMaxResults,
} from "@grasp-os/shared/store-limits";
import { filterSize } from "@grasp-os/shared/store-queries";
import type {
  FilterNode,
  QueryRequest,
  QueryScalar,
  QueryTerminal,
  RangeBound,
  RangeOperator,
  ReadRequest,
} from "@grasp-os/shared/store-queries";

import { indexBase, tablesOf } from "./schema.ts";
import type {
  AnyTable,
  IndexBase,
  SchemaDefinition,
  TableState,
} from "./schema.ts";
import type { Id, ObjectOutput } from "./values.ts";

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
// Every terminal is bounded: `take` and `collect` return at most 100
// records (`collect` fails rather than truncates), a page holds at most
// 100, and there is no way to iterate a whole table. Longer lists page;
// large exports and aggregates are a workflow's.
//
// Adapted from Baseflare's query builder and structured filters (MIT,
// © 2026 Baseflare contributors: packages/baseflare/src/server/db), with
// Convex-style index ranges and Grasp's bounds.

// oxlint-disable-next-line typescript/ban-types -- `& {}` makes an editor show the object's keys instead of this alias
type Simplify<Value> = { [Key in keyof Value]: Value[Key] } & {};

/** The fields every record has, which only the host sets. */
interface ManagedDoc<TableName extends string> {
  readonly _id: Id<TableName>;
  readonly _ownerId: string;
  readonly _rev: number;
  readonly _createdAt: number;
  readonly _updatedAt: number;
}

/**
 * A record of table `TableName`, as a read returns it: its managed fields
 * and its declared fields, as the pinned schema normalizes them.
 */
export type Doc<Table extends AnyTable, TableName extends string> = Simplify<
  ManagedDoc<TableName> & ObjectOutput<Table["fields"]>
>;

/** A schema's tables, by name. */
type AnyTables = Readonly<Record<string, AnyTable>>;

/** The indexes a table declared, by name: the fields of each, in order. */
type IndexesOf<Table> = Table extends {
  readonly "~indexes"?: infer Indexes;
}
  ? NonNullable<Indexes>
  : never;

/** The fields of a table's index `Name`, in order. */
type IndexFields<Table, Name extends PropertyKey> = IndexesOf<Table>[Name &
  keyof IndexesOf<Table>] extends infer Fields extends readonly unknown[]
  ? Fields
  : never;

/** A value a field holds, when it is there: never `undefined`. */
type Present<Value> = Exclude<Value, undefined>;

/** Whether `Value`, null aside, is one scalar type a read can compare. */
type IsComparable<Value> = [NonNullable<Value>] extends [never]
  ? false
  : [NonNullable<Value>] extends [string]
    ? true
    : [NonNullable<Value>] extends [number]
      ? true
      : [NonNullable<Value>] extends [boolean]
        ? true
        : false;

/** The fields of a record a filter may name: its scalar fields. */
type FilterField<Document> = {
  [Key in keyof Document & string]: IsComparable<Document[Key]> extends true
    ? Key
    : never;
}[keyof Document & string];

/** The numeric fields of a record, which `sum`, `min` and `max` take. */
type NumericField<Document> = {
  [Key in keyof Document & string]: [NonNullable<Document[Key]>] extends [
    number,
  ]
    ? [NonNullable<Document[Key]>] extends [never]
      ? never
      : Key
    : never;
}[keyof Document & string];

/**
 * What a filter may say of one field: equal to a value, or a comparison.
 * `null` is a value of its own: `eq: null` matches only an explicit null,
 * never a field left out (`exists: false` matches that), and the
 * comparisons match only values that aren't null.
 */
export interface FieldCondition<Value> {
  readonly eq?: Value;
  readonly neq?: Value;
  readonly gt?: NonNullable<Value>;
  readonly gte?: NonNullable<Value>;
  readonly lt?: NonNullable<Value>;
  readonly lte?: NonNullable<Value>;
  readonly in?: readonly Value[];
  readonly exists?: boolean;
}

/**
 * A query's filter: a condition per field (a bare value means `eq`), all
 * of which must hold, and `AND`, `OR` and `NOT` of other filters. Data,
 * never a function: the host evaluates it.
 */
export type QueryFilter<Document> = {
  readonly [Key in FilterField<Document>]?:
    | Present<Document[Key]>
    | FieldCondition<Present<Document[Key]>>;
} & {
  readonly AND?: readonly QueryFilter<Document>[];
  readonly OR?: readonly QueryFilter<Document>[];
  readonly NOT?: QueryFilter<Document>;
};

/** A range a range builder answers; the brand keeps anything else out. */
export interface IndexRange {
  readonly "~indexRange": true;
}

/** The rest of an index range after a lower bound on `Field`. */
interface LowerBounded<
  Document,
  Field extends keyof Document,
> extends IndexRange {
  readonly lt: (
    field: Field,
    value: NonNullable<Document[Field]>
  ) => IndexRange;
  readonly lte: (
    field: Field,
    value: NonNullable<Document[Field]>
  ) => IndexRange;
}

/**
 * An index range being built over the index fields `Fields` still free:
 * equality on the next field, or a lower and/or upper bound on it, which
 * ends the range.
 */
export type IndexRangeBuilder<
  Document,
  Fields extends readonly unknown[],
> = Fields extends readonly [
  infer Field extends keyof Document,
  ...infer Rest extends readonly unknown[],
]
  ? IndexRange & {
      readonly eq: (
        field: Field,
        value: Present<Document[Field]>
      ) => IndexRangeBuilder<Document, Rest>;
      readonly gt: (
        field: Field,
        value: NonNullable<Document[Field]>
      ) => LowerBounded<Document, Field>;
      readonly gte: (
        field: Field,
        value: NonNullable<Document[Field]>
      ) => LowerBounded<Document, Field>;
      readonly lt: (
        field: Field,
        value: NonNullable<Document[Field]>
      ) => IndexRange;
      readonly lte: (
        field: Field,
        value: NonNullable<Document[Field]>
      ) => IndexRange;
    }
  : IndexRange;

/** The whole numbers 0 to `Max`, as a union. */
type UpTo<
  Max extends number,
  Counted extends readonly number[] = [],
> = Counted["length"] extends Max
  ? Counted[number] | Max
  : UpTo<Max, [...Counted, Counted["length"]]>;

/** How many records `take` may ask for: 0 to 100. */
type ResultCount = UpTo<typeof queryMaxResults>;

/**
 * `Count` if it is a valid result count, or any `number` (checked at run
 * time); a literal out of range fails to type-check.
 */
type Bounded<
  Count extends number,
  Allowed extends number,
> = number extends Count ? Count : Count extends Allowed ? Count : never;

/** What `paginate` takes: as `paginationOptionsValidator` normalizes it. */
export interface PaginationOptions<PageSize extends number = number> {
  readonly pageSize?: Bounded<PageSize, Exclude<ResultCount, 0>>;
  readonly cursor?: string | null;
}

/**
 * One page: its records, and the cursor to the next one while there is
 * one. The last page has no cursor, so an empty cursor never means two
 * things.
 */
export type PaginationResult<Item> =
  | { items: Item[]; nextCursor: null; hasMore: false }
  | { items: Item[]; nextCursor: string; hasMore: true };

/** A query that can be read: its modifiers so far, and its terminals. */
export interface Query<Document> {
  /** Only the records `filter` matches, besides any filter so far. */
  readonly filter: (filter: QueryFilter<Document>) => Query<Document>;
  /**
   * The order to read in, along the index (or by creation time), with the
   * record ID breaking ties. Ascending unless set.
   */
  readonly order: (direction: "asc" | "desc") => Omit<Query<Document>, "order">;
  /** At most `count` records, 0 to 100. */
  readonly take: <const Count extends number>(
    count: Bounded<Count, ResultCount>
  ) => Promise<Document[]>;
  /** The first record, or null. */
  readonly first: () => Promise<Document | null>;
  /** The only record, or null; `data.not_unique` if there are more. */
  readonly unique: () => Promise<Document | null>;
  /** How many records there are, within the host's scan bound. */
  readonly count: () => Promise<number>;
  /** Every record, at most 100; `data.result_limit` if there are more. */
  readonly collect: () => Promise<Document[]>;
  /** One page, of `pageSize` records (50 unless set) from `cursor`. */
  readonly paginate: <
    const PageSize extends number = typeof queryDefaultPageSize,
  >(
    options: PaginationOptions<PageSize>
  ) => Promise<PaginationResult<Document>>;
  /** A count, or the sum, least or greatest value of a numeric field. */
  readonly aggregate: Aggregate<Document>;
}

/** `aggregate`'s operations. */
export interface Aggregate<Document> {
  (
    options:
      | { readonly operation: "count" }
      | { readonly operation: "sum"; readonly field: NumericField<Document> }
  ): Promise<number>;
  (options: {
    readonly operation: "min" | "max";
    readonly field: NumericField<Document>;
  }): Promise<number | null>;
}

/** A query of one table, before an index is chosen. */
export interface QueryInitializer<
  Table extends AnyTable,
  TableName extends string,
> extends Query<Doc<Table, TableName>> {
  /**
   * Reads through index `name`, in its order, within the range `range`
   * builds: equality on its first fields, then a lower and/or upper bound
   * on the next.
   */
  readonly withIndex: <const Name extends keyof IndexesOf<Table> & string>(
    name: Name,
    range?: (
      range: IndexRangeBuilder<Doc<Table, TableName>, IndexFields<Table, Name>>
    ) => IndexRange
  ) => Query<Doc<Table, TableName>>;
}

/** What `get` may assert. */
export interface GetOptions {
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
  ) => QueryInitializer<Tables[TableName], TableName>;
}

/**
 * Runs one read for the invocation: supplied by the trusted host, which
 * resolves the caller, the store and the pinned schema itself.
 */
export type ReadExecutor = (request: ReadRequest) => Promise<unknown>;

/** Why a query was refused while it was built. */
export type QueryDefinitionCode =
  | "query.unknown_table"
  | "query.unknown_index"
  | "query.invalid_range"
  | "query.invalid_filter"
  | "query.invalid_terminal";

/**
 * A query built wrongly: thrown before anything is read. `code` is an own
 * property, so it crosses an RPC boundary.
 */
export class QueryDefinitionError extends Error {
  readonly code: QueryDefinitionCode;

  constructor(code: QueryDefinitionCode, message: string) {
    super(message);
    this.name = "QueryDefinitionError";
    this.code = code;
  }
}

// Typed where it is declared: only then does a call narrow what follows it.
const refuse: (code: QueryDefinitionCode, message: string) => never = (
  code,
  message
) => {
  throw new QueryDefinitionError(code, message);
};

/** The managed fields a read may compare, and the base type of each. */
const managedBases: Readonly<Record<string, IndexBase>> = {
  _id: "string",
  _ownerId: "string",
  _rev: "number",
  _createdAt: "number",
  _updatedAt: "number",
};

/** The base type of a field a read may compare, or undefined. */
const baseOf = (table: TableState, field: string): IndexBase | undefined => {
  if (Object.hasOwn(managedBases, field)) {
    return managedBases[field];
  }
  const descriptor = Object.hasOwn(table.fields, field)
    ? table.fields[field]
    : undefined;
  return descriptor === undefined ? undefined : indexBase(descriptor);
};

/** Whether `value` is a scalar of base type `base` (or null, if allowed). */
const fits = (value: unknown, base: IndexBase, allowNull: boolean): boolean => {
  if (value === null) {
    return allowNull;
  }
  if (base === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeof value === base;
};

/** Every range builder this module made, with what it recorded. */
const ranges = new WeakMap<object, readonly RangeBound[]>();

/**
 * A range over index fields `fields` (the ones still free), after
 * `bounds`. Each call answers a new range; a call out of order, on the
 * wrong field, or after the range ended is refused.
 */
const rangeOf = (
  table: TableState,
  fields: readonly string[],
  bounds: readonly RangeBound[],
  lowerOn: string | null,
  ended: boolean
): IndexRange => {
  const add = (
    op: RangeOperator,
    field: unknown,
    value: unknown
  ): IndexRange => {
    if (ended) {
      return refuse(
        "query.invalid_range",
        "An index range ends at its upper bound; nothing can follow it."
      );
    }
    const expected = lowerOn ?? fields[0];
    if (typeof field !== "string" || field !== expected) {
      return refuse(
        "query.invalid_range",
        expected === undefined
          ? "This index range has no field left to bound."
          : `An index range bounds its fields in order: next is \`${expected}\`.`
      );
    }
    if (lowerOn !== null && op !== "lt" && op !== "lte") {
      return refuse(
        "query.invalid_range",
        `After a lower bound on \`${field}\` only an upper bound on it may follow.`
      );
    }
    const base = baseOf(table, field);
    if (base === undefined || !fits(value, base, op === "eq")) {
      return refuse(
        "query.invalid_range",
        op === "eq"
          ? `\`${field}\` is compared with a ${base ?? "scalar"} or null.`
          : `\`${field}\` is bounded by a ${base ?? "scalar"}, never null.`
      );
    }
    // SAFETY: `fits` checked it is a scalar of the field's type, or null.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const bound = { field, op, value: value as QueryScalar };
    const next = [...bounds, bound];
    if (op === "eq") {
      return rangeOf(table, fields.slice(1), next, null, false);
    }
    if (op === "gt" || op === "gte") {
      return rangeOf(table, fields.slice(1), next, field, false);
    }
    return rangeOf(table, fields, next, null, true);
  };
  const range = Object.freeze({
    "~indexRange": true as const,
    eq: (field: unknown, value: unknown) =>
      lowerOn === null
        ? add("eq", field, value)
        : refuse(
            "query.invalid_range",
            `After a lower bound on \`${lowerOn}\` only an upper bound on it may follow.`
          ),
    gt: (field: unknown, value: unknown) =>
      lowerOn === null
        ? add("gt", field, value)
        : refuse(
            "query.invalid_range",
            `\`${lowerOn}\` has a lower bound already.`
          ),
    gte: (field: unknown, value: unknown) =>
      lowerOn === null
        ? add("gte", field, value)
        : refuse(
            "query.invalid_range",
            `\`${lowerOn}\` has a lower bound already.`
          ),
    lt: (field: unknown, value: unknown) => add("lt", field, value),
    lte: (field: unknown, value: unknown) => add("lte", field, value),
  });
  ranges.set(range, Object.freeze(bounds));
  return range;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const comparisonOps = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

/** One condition of `field.op`, checked against the field's base type. */
const conditionNode = (
  field: string,
  base: IndexBase,
  op: string,
  operand: unknown
): FilterNode => {
  if (op === "exists") {
    if (typeof operand !== "boolean") {
      return refuse(
        "query.invalid_filter",
        `\`${field}.exists\` is a boolean.`
      );
    }
    return { field, op, value: operand };
  }
  if (op === "in") {
    if (
      !Array.isArray(operand) ||
      operand.length > filterMaxInValues ||
      !operand.every((item) => fits(item, base, true))
    ) {
      return refuse(
        "query.invalid_filter",
        `\`${field}.in\` lists at most ${filterMaxInValues} values, each a ${base} or null.`
      );
    }
    // SAFETY: each item was checked to be a scalar of the field's type.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return { field, op, values: operand as QueryScalar[] };
  }
  const compared = comparisonOps.find((known) => known === op);
  if (compared === undefined) {
    return refuse(
      "query.invalid_filter",
      `\`${field}\` takes \`eq\`, \`neq\`, \`gt\`, \`gte\`, \`lt\`, \`lte\`, \`in\` or \`exists\`.`
    );
  }
  const allowNull = compared === "eq" || compared === "neq";
  if (!fits(operand, base, allowNull)) {
    return refuse(
      "query.invalid_filter",
      allowNull
        ? `\`${field}.${op}\` is a ${base} or null.`
        : `\`${field}.${op}\` is a ${base}, never null.`
    );
  }
  // SAFETY: `fits` checked it is a scalar of the field's type (or null).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return { field, op: compared, value: operand as QueryScalar };
};

/** The conditions a filter object states of `field`. */
const fieldNodes = (
  table: TableState,
  field: string,
  value: unknown
): FilterNode[] => {
  const base = baseOf(table, field);
  if (base === undefined) {
    return refuse(
      "query.invalid_filter",
      `A filter names scalar fields of the table: \`${field}\` isn't one.`
    );
  }
  if (!isPlainRecord(value)) {
    return [conditionNode(field, base, "eq", value)];
  }
  return Object.entries(value).map(([op, operand]) => {
    if (operand === undefined) {
      return refuse(
        "query.invalid_filter",
        `\`${field}.${op}\` is undefined: leave it out instead.`
      );
    }
    return conditionNode(field, base, op, operand);
  });
};

/** An author's filter object, as the tree a descriptor holds. */
const filterTree = (
  table: TableState,
  filter: unknown,
  depth: number
): FilterNode => {
  if (depth > filterMaxDepth) {
    return refuse(
      "query.invalid_filter",
      `A filter nests at most ${filterMaxDepth} deep.`
    );
  }
  if (!isPlainRecord(filter)) {
    return refuse(
      "query.invalid_filter",
      "A filter is an object of fields and `AND`, `OR` or `NOT`."
    );
  }
  const nodes: FilterNode[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) {
      return refuse(
        "query.invalid_filter",
        `\`${key}\` is undefined: leave it out instead.`
      );
    }
    if (key === "AND" || key === "OR") {
      if (!Array.isArray(value)) {
        return refuse(
          "query.invalid_filter",
          `\`${key}\` is a list of filters.`
        );
      }
      const children = value.map((child) =>
        filterTree(table, child, depth + 1)
      );
      nodes.push(key === "AND" ? { and: children } : { or: children });
    } else if (key === "NOT") {
      nodes.push({ not: filterTree(table, value, depth + 1) });
    } else {
      nodes.push(...fieldNodes(table, key, value));
    }
  }
  const [only, ...others] = nodes;
  return only !== undefined && others.length === 0 ? only : { and: nodes };
};

/** A count a terminal takes, checked: a whole number from `min` to 100. */
const checkedCount = (value: unknown, min: number, what: string): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > queryMaxResults
  ) {
    return refuse(
      "query.invalid_terminal",
      `${what} is a whole number from ${min} to ${queryMaxResults}.`
    );
  }
  return value;
};

/** Whether `value` is a function, to be called with a range. */
const isRangeFunction = (
  value: unknown
): value is (range: IndexRange) => unknown => typeof value === "function";

/** What a query has been given so far. */
interface QueryState {
  readonly table: string;
  readonly state: TableState;
  readonly index: string | null;
  readonly range: readonly RangeBound[];
  readonly filter: FilterNode | null;
  readonly order: "asc" | "desc";
}

/**
 * A query as this module builds it: the methods `Query` types, taking
 * anything, since App code may call them with anything.
 */
interface RuntimeQuery {
  readonly filter: (filter: unknown) => RuntimeQuery;
  readonly order: (direction: unknown) => RuntimeQuery;
  readonly take: (count: unknown) => Promise<unknown>;
  readonly first: () => Promise<unknown>;
  readonly unique: () => Promise<unknown>;
  readonly count: () => Promise<unknown>;
  readonly collect: () => Promise<unknown>;
  readonly paginate: (options: unknown) => Promise<unknown>;
  readonly aggregate: (options: unknown) => Promise<unknown>;
}

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
}

/** The query `query`, with the modifiers and terminals reading it. */
const queryOf = (query: QueryState, execute: ReadExecutor): RuntimeQuery => {
  const run = async (terminal: QueryTerminal): Promise<unknown> => {
    const request: QueryRequest = {
      table: query.table,
      index: query.index,
      range: [...query.range],
      filter: query.filter,
      order: query.order,
      terminal,
    };
    return await execute({ kind: "query", query: request });
  };
  const numericField = (field: unknown): string => {
    if (typeof field !== "string" || baseOf(query.state, field) !== "number") {
      return refuse(
        "query.invalid_terminal",
        "`sum`, `min` and `max` take a numeric field of the table."
      );
    }
    return field;
  };
  return Object.freeze({
    filter: (filter: unknown) => {
      const tree = filterTree(query.state, filter, 0);
      const combined: FilterNode =
        query.filter === null ? tree : { and: [query.filter, tree] };
      const size = filterSize(combined);
      if (size.nodes > filterMaxNodes || size.depth > filterMaxDepth) {
        refuse(
          "query.invalid_filter",
          `A query's filters nest at most ${filterMaxDepth} deep and hold at most ${filterMaxNodes} nodes.`
        );
      }
      return queryOf({ ...query, filter: combined }, execute);
    },
    order: (direction: unknown) => {
      if (direction !== "asc" && direction !== "desc") {
        return refuse(
          "query.invalid_terminal",
          'A query is ordered `"asc"` or `"desc"`.'
        );
      }
      return queryOf({ ...query, order: direction }, execute);
    },
    take: async (count: unknown) =>
      await run({ kind: "take", count: checkedCount(count, 0, "`take`") }),
    first: async () => await run({ kind: "first" }),
    unique: async () => await run({ kind: "unique" }),
    count: async () => await run({ kind: "count" }),
    collect: async () => await run({ kind: "collect" }),
    paginate: async (options: unknown) => {
      if (!isPlainRecord(options)) {
        return refuse(
          "query.invalid_terminal",
          "`paginate` takes `{ pageSize, cursor }`."
        );
      }
      const { pageSize = queryDefaultPageSize, cursor = null } = options;
      if (cursor !== null && (typeof cursor !== "string" || cursor === "")) {
        return refuse(
          "query.invalid_terminal",
          "A cursor is a non-empty string, or null for the first page."
        );
      }
      return await run({
        kind: "paginate",
        pageSize: checkedCount(pageSize, 1, "`pageSize`"),
        cursor,
      });
    },
    aggregate: async (options: unknown) => {
      const operation = isPlainRecord(options) ? options.operation : undefined;
      if (operation === "count") {
        return await run({ kind: "aggregate", operation });
      }
      if (operation === "sum" || operation === "min" || operation === "max") {
        return await run({
          kind: "aggregate",
          operation,
          field: numericField(
            isPlainRecord(options) ? options.field : undefined
          ),
        });
      }
      return refuse(
        "query.invalid_terminal",
        "`aggregate` takes `count`, `sum`, `min` or `max`."
      );
    },
  });
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
    get: async (table: unknown, id: unknown, options: unknown = {}) => {
      const { name } = stateOf(table);
      const expected = isPlainRecord(options)
        ? options.expectedRevision
        : undefined;
      if (
        typeof id !== "string" ||
        id === "" ||
        (expected !== undefined &&
          (typeof expected !== "number" ||
            !Number.isSafeInteger(expected) ||
            expected < 1))
      ) {
        return refuse(
          "query.invalid_terminal",
          "`get` takes a record ID, and an `expectedRevision` that is a whole number of at least 1."
        );
      }
      return await execute({
        kind: "get",
        table: name,
        id,
        expectedRevision: expected ?? null,
      });
    },
    query: (table: unknown) => {
      const { name, state } = stateOf(table);
      const base: QueryState = {
        table: name,
        state,
        index: null,
        range: [],
        filter: null,
        order: "asc",
      };
      const query = queryOf(base, execute);
      return Object.freeze({
        ...query,
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
          let range: readonly RangeBound[] = [];
          if (build !== undefined) {
            if (!isRangeFunction(build)) {
              return refuse(
                "query.invalid_range",
                "An index range is built by a function of the range."
              );
            }
            const built = build(
              rangeOf(state, declared.fields, [], null, false)
            );
            const recorded =
              typeof built === "object" && built !== null
                ? ranges.get(built)
                : undefined;
            if (recorded === undefined) {
              return refuse(
                "query.invalid_range",
                "An index range's function returns the range it built."
              );
            }
            range = recorded;
          }
          return queryOf({ ...base, index: declared.name, range }, execute);
        },
      });
    },
  };
  // SAFETY: each method checks at run time what `DatabaseReader` types (a
  // table, index, range, filter or terminal of the schema), and answers
  // what the host returns for the request it was built into, which the
  // host shapes as `Doc` of the pinned schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return Object.freeze(reader) as DatabaseReader<Tables>;
};
