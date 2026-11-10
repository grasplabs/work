import type { IndexableManagedField } from "./schema-indexes.ts";
import type { AccessModes, RowRules, TableAccess } from "./table-access.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import type { Infer, ValueShape } from "./value-types.ts";

/** One index of a table: its name and the fields it orders by, in order. */
export interface IndexDefinition {
  readonly name: string;
  readonly fields: readonly string[];
}

/** A value that is a whole scalar, one of a single base type. */
type IsScalar<Value> = [NonNullable<Value>] extends [never]
  ? false
  : [NonNullable<Value>] extends [string]
    ? true
    : [NonNullable<Value>] extends [number]
      ? true
      : [NonNullable<Value>] extends [boolean]
        ? true
        : false;

/**
 * The fields an index of these fields may name: a scalar field of one base
 * type (null and absence allowed), or a commit time.
 */
export type IndexField<Fields extends ValueShape> =
  | IndexableManagedField
  | {
      [Key in keyof Fields & string]: IsScalar<Infer<Fields[Key]>> extends true
        ? Key
        : never;
    }[keyof Fields & string];

/**
 * The fields a search index may cover: those whose values are text (a
 * string, an enum of strings, a template), null and absence allowed.
 */
export type SearchField<Fields extends ValueShape> = {
  [Key in keyof Fields & string]: [NonNullable<Infer<Fields[Key]>>] extends [
    never,
  ]
    ? never
    : [NonNullable<Infer<Fields[Key]>>] extends [string]
      ? Key
      : never;
}[keyof Fields & string];

/** Names a table's indexes by the fields they order by. */
type IndexMap = Readonly<Record<string, readonly string[]>>;

/** A table with no indexes yet. */
type NoIndexes = Readonly<Record<never, readonly string[]>>;

/**
 * A table: its fields, its indexes and its search index, immutable.
 * `.index` answers a new table with one more index, `.searchIndex` one
 * with its search index.
 */
export interface TableDefinition<
  Fields extends ValueShape = ValueShape,
  Indexes extends IndexMap = NoIndexes,
  Searchable extends boolean = false,
> {
  readonly fields: Fields;
  /** In the order they were declared. */
  readonly indexes: readonly IndexDefinition[];
  /**
   * The same table with one more index, by `fields` in this order. The
   * host adds the table and the record ID itself; don't name them.
   */
  readonly index: <
    const Name extends string,
    const Keys extends readonly [IndexField<Fields>, ...IndexField<Fields>[]],
  >(
    name: Name,
    fields: Keys
  ) => TableDefinition<
    Fields,
    Indexes & Readonly<Record<Name, Keys>>,
    Searchable
  >;
  /**
   * The same table with a full-text search index over its text `fields`
   * (at most 8), which `ctx.db.search(table, text)` reads: the store keeps
   * it in step with every write, and builds it over the records already
   * there when a version declaring it is applied. A table has one.
   *
   * ```ts
   * defineTable({ name: v.string(), notes: v.string().optional() })
   *   .searchIndex(["name", "notes"]);
   * ```
   */
  readonly searchIndex: Searchable extends true
    ? never
    : <
        // Generic, as `index` is, so a manifest's table, declared from
        // data (schema-manifest.ts), takes its fields as a list of anything.
        // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- see above
        const Keys extends readonly [
          SearchField<Fields>,
          ...SearchField<Fields>[],
        ],
      >(
        fields: Keys
      ) => TableDefinition<Fields, Indexes, true>;
  /**
   * The same table, its data declared sensitive: the store's change
   * history of its records keeps which fields changed, never their values,
   * and every read of it is recorded in the audit log (who read, through
   * which function, how many reads and records, never the values).
   * Once any schema handed to a store declares a table so, it stays so.
   */
  readonly sensitive: () => TableDefinition<Fields, Indexes, Searchable>;
  /**
   * The same table with its access: who reads it and who writes it
   * (`read` and `write`, each `owner`, `appMembers`, `appBuilders` or
   * `none`, the default), and its row rules (`rows`): which of its rows
   * each caller reads, and which they write, once the mode lets them
   * reach the table at all. Each direction of `rows` lists at least one
   * rule, and a row reaches whoever any of them admits. Writing a row
   * takes both: a write changes only a row its read and its write rules
   * admit the writer to, and leaves it where they both still do. Without
   * write rules, its read rules are its write rules too; without read
   * rules, reading is the mode's alone. The store enforces them on every
   * read and write: no App code gets past them. A direction with rules
   * has the mode `appMembers` or `appBuilders` (`rows.owner()` is how a
   * rule says `owner`). A table without `.access` reaches nobody.
   */
  readonly access: (
    access: TableAccess<SearchField<Fields>>
  ) => TableDefinition<Fields, Indexes, Searchable>;
  /** Its indexes, by name, for types only: never set. */
  readonly "~indexes"?: Indexes;
  /** Whether it has a search index, for types only: never set. */
  readonly "~searchable"?: Searchable;
}

/** Any table, as a schema holds it. */
export interface AnyTable {
  readonly fields: ValueShape;
  readonly indexes: readonly IndexDefinition[];
}

/** A schema: its tables, by name. */
export interface SchemaDefinition<
  Tables extends Readonly<Record<string, AnyTable>> = Readonly<
    Record<string, AnyTable>
  >,
> {
  readonly tables: Tables;
}

/** A table as its schema's manifest reads it: descriptors, not schemas. */
export interface TableState {
  readonly fields: Readonly<Record<string, ValueDescriptor>>;
  readonly indexes: readonly IndexDefinition[];
  /** The text fields its search index covers, in order; none without one. */
  readonly searchIndex?: readonly string[];
  /** Declared sensitive (`TableDefinition.sensitive`); left out otherwise. */
  readonly sensitive?: true;
  /** Its access modes, as `.access` declared them; `none` both ways without. */
  readonly access?: AccessModes;
  /** Its row rules, as `.access` declared them (`rows`); none without. */
  readonly rules?: RowRules;
}
