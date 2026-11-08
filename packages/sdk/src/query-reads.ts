import type {
  AnyTables,
  Doc,
  IsComparable,
  NumericField,
  QueryFilter,
  Simplify,
} from "./query-types.ts";
import type { Id } from "./value-types.ts";

/** What `paginate` takes: as `paginationOptionsValidator` normalizes it. */
interface PaginationOptions {
  /** How many records the page holds, 50 unless set. */
  readonly pageSize?: number;
  readonly cursor?: string | null;
  /**
   * Where the page ends, whatever `pageSize` says: a live list's loaded
   * pages pass the cursor their next page starts at, so a page keeps its
   * bounds as records move. Pass `pagination` on as it came.
   */
  readonly endCursor?: string | null;
}

/**
 * One page: its records, and the cursor to the next one while there is
 * one. The last page has no cursor, so an empty cursor never means two
 * things.
 */
export type PaginationResult<Item> = (
  | { items: Item[]; nextCursor: null; hasMore: false }
  | { items: Item[]; nextCursor: string; hasMore: true }
) & {
  /**
   * Where to split a page given an end that grew past twice its size,
   * after its first `pageSize` records: what a live list does with it.
   */
  splitCursor?: string;
};

/**
 * A related record `.with` couldn't show: the caller can't read its table.
 * Field names never start with `_`, so no record is ever this.
 */
export interface Withheld {
  readonly _withheld: true;
}

/** The scalar fields of a record a grouped read may group by. */
type GroupField<Document> = {
  [Key in keyof Document & string]: Key extends `_${string}`
    ? never
    : IsComparable<Document[Key]> extends true
      ? Key
      : never;
}[keyof Document & string];

/** The fields of a record `.with` follows: a `v.id`, or a list of them. */
type RelationField<Document> = {
  [Key in keyof Document & string]: Key extends `_${string}`
    ? never
    : [NonNullable<Document[Key]>] extends [never]
      ? never
      : [NonNullable<Document[Key]>] extends [Id]
        ? Key
        : [NonNullable<Document[Key]>] extends [readonly Id[]]
          ? Key
          : never;
}[keyof Document & string];

/** A table's record by the table's name, typed by the schema's tables. */
type DocOf<
  Tables extends AnyTables,
  TableName,
> = TableName extends keyof Tables & string
  ? Doc<Tables[TableName], TableName>
  : never;

/**
 * What `.with` loads for a field holding `Value`: the record it names
 * (null when the field holds none, or names none the caller may see:
 * missing, deleted, another owner's, or one its table's row rules keep
 * from them), a list of them for a list of IDs,
 * or `Withheld` when the caller can't read the table at all.
 */
export type Related<Value, Tables extends AnyTables> = [
  NonNullable<Value>,
] extends [Id<infer TableName>]
  ? DocOf<Tables, TableName> | null | Withheld
  : [NonNullable<Value>] extends [readonly Id<infer TableName>[]]
    ? (DocOf<Tables, TableName> | null)[] | null | Withheld
    : never;

/** A record with the related records of `Fields`, as `.with` answers it. */
type WithRelated<
  Document,
  Fields extends keyof Document,
  Tables extends AnyTables,
> = Simplify<
  Omit<Document, "_with"> & {
    readonly _with: Simplify<
      (Document extends { readonly _with: infer Before } ? Before : unknown) & {
        readonly [Field in Fields]-?: Related<Document[Field], Tables>;
      }
    >;
  }
>;

/**
 * What `group` takes: the fields to group by, and the declared numeric
 * fields to sum, average, or take the least or greatest of in each group.
 */
interface GroupOptions<
  Document,
  By extends GroupField<Document>,
  Sum extends NumericField<Document>,
  Avg extends NumericField<Document>,
  Min extends NumericField<Document>,
  Max extends NumericField<Document>,
> {
  readonly by: readonly [By, ...By[]];
  readonly sum?: readonly Sum[];
  readonly avg?: readonly Avg[];
  readonly min?: readonly Min[];
  readonly max?: readonly Max[];
}

/**
 * One group: its key (each `by` field's value, null for an explicit null,
 * left out where its records leave the field out), how many records it
 * holds, and its aggregates. A sum of no numbers is 0; an average, least
 * or greatest of none is null.
 */
export interface Group<
  Document,
  By extends keyof Document,
  Sum extends string,
  Avg extends string,
  Min extends string,
  Max extends string,
> {
  readonly key: Simplify<Pick<Document, By>>;
  readonly count: number;
  readonly sum: Readonly<Record<Sum, number>>;
  readonly avg: Readonly<Record<Avg, number | null>>;
  readonly min: Readonly<Record<Min, number | null>>;
  readonly max: Readonly<Record<Max, number | null>>;
}

/** A query's terminals that return records: each reads, bounded. */
interface RecordReads<Document> {
  /** At most `count` records. */
  readonly take: (count: number) => Promise<Document[]>;
  /** The first record, or null. */
  readonly first: () => Promise<Document | null>;
  /** How many records there are, within the host's scan bound. */
  readonly count: () => Promise<number>;
  /**
   * Every record, within the host's scan bound: `data.scan_limit` if it
   * would read more, never a part. Page through larger lists.
   */
  readonly collect: () => Promise<Document[]>;
  /**
   * One page, of `pageSize` records (50 unless set) from `cursor`. Pages
   * go on through a table of any size: each costs only what it reads.
   */
  readonly paginate: (
    options: PaginationOptions
  ) => Promise<PaginationResult<Document>>;
}

/**
 * A search of one table's search index (`ctx.db.search`): its records in
 * order of relevance, best first, the record ID breaking ties. Filter it,
 * load related records, and read it with any terminal that returns
 * records. Relevance moves with every write to the table, so a record
 * changed between pages may move past or into a later page; a cursor
 * whose last record is gone or no longer matches expires
 * (`data.cursor_expired`): start again from the first page then.
 */
export type SearchQuery<
  Document,
  Tables extends AnyTables = AnyTables,
> = RecordReads<Document> & {
  /** Only the records `filter` matches, besides the search. */
  readonly filter: (
    filter: QueryFilter<Document>
  ) => SearchQuery<Document, Tables>;
  /** Each record with the records its `fields` name (`Query.with`). */
  readonly with: <const Fields extends readonly RelationField<Document>[]>(
    ...fields: Fields
  ) => SearchQuery<WithRelated<Document, Fields[number], Tables>, Tables>;
};

/** A query's terminals: each reads, bounded. */
interface QueryReads<Document> extends RecordReads<Document> {
  /** The only record, or null; `data.not_unique` if there are more. */
  readonly unique: () => Promise<Document | null>;
  /** A count, or the sum, least or greatest of a declared numeric field. */
  readonly aggregate: Aggregate<Document>;
  /**
   * The records counted per distinct value of one or more scalar fields
   * (`by`), with sums, averages, least and greatest values of declared
   * numeric fields per group, ordered by key, over the records the
   * query reads within the host's scan bound (`data.scan_limit` past it,
   * never a part). Larger reports are a
   * workflow's, in pages.
   *
   * ```ts
   * const byStatus = await ctx.db
   *   .query("orders")
   *   .withIndex("by_region", (range) => range.eq("region", "EU"))
   *   .group({ by: ["status"], sum: ["amount"], avg: ["amount"] });
   * // [{ key: { status: "open" }, count: 12, sum: { amount: 4200 }, avg: { amount: 350 }, min: {}, max: {} }, ...]
   * ```
   */
  readonly group: <
    const By extends GroupField<Document>,
    const Sum extends NumericField<Document> = never,
    const Avg extends NumericField<Document> = never,
    const Min extends NumericField<Document> = never,
    const Max extends NumericField<Document> = never,
  >(
    options: GroupOptions<Document, By, Sum, Avg, Min, Max>
  ) => Promise<Group<Document, By, Sum, Avg, Min, Max>[]>;
}

/**
 * A query that can be read: its terminals, more filters, related records,
 * and its order while it has none (`Ordered`): a query is ordered once.
 */
export type Query<
  Document,
  Ordered extends boolean = false,
  Tables extends AnyTables = AnyTables,
> = QueryReads<Document> & {
  /** Only the records `filter` matches, besides any filter so far. */
  readonly filter: (
    filter: QueryFilter<Document>
  ) => Query<Document, Ordered, Tables>;
  /**
   * Each record it returns with the records its `v.id` fields (or lists
   * of them) name, under `_with`: loaded together, a statement per field,
   * under the caller's access to their tables. A record
   * the caller may not see (missing, deleted, another owner's, or one its
   * table's row rules keep from them) is null; a
   * table the caller can't read at all is `{ _withheld: true }`. Only for
   * terminals that return records.
   *
   * ```ts
   * const orders = await ctx.db.query("orders").with("customer").take(20);
   * orders[0]._with.customer; // Doc<"customers"> | null | { _withheld: true }
   * ```
   */
  readonly with: <const Fields extends readonly RelationField<Document>[]>(
    ...fields: Fields
  ) => Query<WithRelated<Document, Fields[number], Tables>, Ordered, Tables>;
} & (Ordered extends true
    ? unknown
    : {
        /**
         * The order to read in, along the index (or by creation time),
         * with the record ID breaking ties. Ascending unless set.
         */
        readonly order: (
          direction: "asc" | "desc"
        ) => Query<Document, true, Tables>;
      });

/** `aggregate`'s operations. */
interface Aggregate<Document> {
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
