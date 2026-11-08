import type { AnyTable } from "./schema-types.ts";
import type { Id, ObjectOutput } from "./values.ts";

// oxlint-disable-next-line typescript/ban-types -- `& {}` makes an editor show the object's keys instead of this alias
export type Simplify<Value> = { [Key in keyof Value]: Value[Key] } & {};

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
export type AnyTables = Readonly<Record<string, AnyTable>>;

/** The indexes a table declared, by name: the fields of each, in order. */
export type IndexesOf<Table> = Table extends {
  readonly "~indexes"?: infer Indexes;
}
  ? NonNullable<Indexes>
  : never;

/** The fields of a table's index `Name`, in order. */
export type IndexFields<
  Table,
  Name extends PropertyKey,
> = IndexesOf<Table>[Name & keyof IndexesOf<Table>] extends infer Fields extends
  readonly unknown[]
  ? Fields
  : never;

/** A value a field holds, when it is there: never `undefined`. */
export type Present<Value> = Exclude<Value, undefined>;

/** Whether `Value`, null aside, is one scalar type a read can compare. */
export type IsComparable<Value> = [NonNullable<Value>] extends [never]
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

/**
 * The declared numeric fields of a record, which `sum`, `min` and `max`
 * take: never a managed field.
 */
export type NumericField<Document> = {
  [Key in keyof Document & string]: Key extends `_${string}`
    ? never
    : [NonNullable<Document[Key]>] extends [number]
      ? [NonNullable<Document[Key]>] extends [never]
        ? never
        : Key
      : never;
}[keyof Document & string];

/**
 * What a filter may say of one field. A record matches a condition or it
 * doesn't; a field holds a value, holds an explicit null, or is left out:
 * - `eq` with a value, `gt`, `gte`, `lt`, `lte` and `neq` match only a
 *   field that holds a value: `{ neq: "a" }` matches values other than
 *   "a", never null or a field left out, and `{ neq: null }` any value;
 * - `{ eq: null }`, and `in` listing null, match an explicit null only;
 * - `{ exists: false }` matches a field left out only, and
 *   `{ exists: true }` null or a value.
 *
 * ```ts
 * ctx.db.query("notes").filter({ summary: null }); // explicit null only
 * ctx.db.query("notes").filter({ rank: { exists: false } }); // left out only
 * ctx.db.query("notes").filter({ rank: { lt: 3 } }); // values below 3 only
 * ```
 */
interface FieldCondition<Value> {
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
 * of which must hold, and `AND` and `OR` of at least one filter, and
 * `NOT`. `NOT` is plain negation: `{ NOT: { title: "a" } }` matches every
 * record whose title isn't "a", those without a title included. Data,
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
 * ends the range. Lower and upper bounds match values only, so an upper
 * bound never reaches null or a field left out; `eq` with null matches an
 * explicit null only.
 *
 * ```ts
 * ctx.db
 *   .query("notes")
 *   .withIndex("by_author_rank", (range) =>
 *     range.eq("author", args.author).gte("rank", 1).lt("rank", 5)
 *   );
 * ```
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
