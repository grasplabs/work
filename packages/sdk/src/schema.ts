import {
  storeMaxTables,
  storeNameMaxLength,
  storeNamePattern,
} from "@grasp-os/shared/store-limits";

import { descriptorVersion, isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { fieldDescriptors, seal } from "./value-schema.ts";
import type { Infer, ValueShape } from "./values.ts";

// `defineSchema` and `defineTable`: how an App (or a store of its own)
// declares its tables once. A schema is a value, like a `v` schema: frozen,
// built only from `v` schemas, and checked whole as it is built, so one that
// exists is valid. It runs nothing and registers nothing: declaring a
// schema is not creating a store, and has no SQL to run.
//
// The same declaration is what records are validated against, what types
// `Doc` and `Id`, what a store's host is handed (its canonical manifest,
// schema-manifest.ts) and what two versions are compared by. Which tables a
// caller may read or write is declared beside it (an App's `access`), never
// in it.
//
// Adapted from Baseflare's `defineSchema` and `defineTable` (MIT, © 2026
// Baseflare contributors: packages/baseflare/src/server/schema), without
// its physical layout: a table here is logical, and its records live in
// the store's one fixed layout (apps/core/src/db/data-store/schema.ts).

/**
 * The fields every record has, which only the host sets: its ID, its
 * owner, its revision, and when it was created and last changed. A caller
 * can read them but never write, patch or unset them; an authored field
 * can't take their names (none starts with `_`).
 */
export const managedFields = Object.freeze([
  "_id",
  "_ownerId",
  "_rev",
  "_createdAt",
  "_updatedAt",
] as const);

/** The managed fields an index may name: the commit times. */
export type IndexableManagedField = "_createdAt" | "_updatedAt";

const indexableManaged: ReadonlySet<unknown> = new Set<IndexableManagedField>([
  "_createdAt",
  "_updatedAt",
]);

/**
 * The bounds of one schema. Indexes per table and fields per index are the
 * host's own until the runtime policy module sets validated quotas per
 * deployment, which may only lower them.
 */
export const schemaLimits = Object.freeze({
  /** Tables in one schema: as many as a store holds. */
  tables: storeMaxTables,
  /** Code units in a table, field or index name. */
  nameLength: storeNameMaxLength,
  /** Indexes on one table. */
  indexesPerTable: 32,
  /** Fields in one index. */
  fieldsPerIndex: 16,
} as const);

/**
 * The keys of a query filter's logic (`AND`, `OR`, `NOT`): never a field,
 * in any case, so a filter can't be read two ways.
 */
const filterOperators: ReadonlySet<string> = new Set(["and", "or", "not"]);

/** Why a schema's declaration was refused. */
export type SchemaDefinitionCode =
  | "schema.invalid_name"
  | "schema.name_conflict"
  | "schema.invalid_table"
  | "schema.invalid_index"
  | "schema.unknown_table"
  | "schema.too_large"
  | "schema.invalid_access"
  | "schema.invalid_manifest";

/**
 * A schema declared wrongly: thrown while it is built or read back from a
 * manifest. `code` is an own property, so it crosses an RPC boundary.
 */
export class SchemaDefinitionError extends Error {
  readonly code: SchemaDefinitionCode;

  constructor(code: SchemaDefinitionCode, message: string) {
    super(message);
    this.name = "SchemaDefinitionError";
    this.code = code;
  }
}

// Typed where it is declared: only then does a call narrow what follows it.
const refuse: (code: SchemaDefinitionCode, message: string) => never = (
  code,
  message
) => {
  throw new SchemaDefinitionError(code, message);
};

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

/** Names a table's indexes by the fields they order by. */
export type IndexMap = Readonly<Record<string, readonly string[]>>;

/** A table with no indexes yet. */
export type NoIndexes = Readonly<Record<never, readonly string[]>>;

/**
 * A table: its fields and its indexes, immutable. `.index` answers a new
 * table with one more index.
 */
export interface TableDefinition<
  Fields extends ValueShape = ValueShape,
  Indexes extends IndexMap = NoIndexes,
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
  ) => TableDefinition<Fields, Indexes & Readonly<Record<Name, Keys>>>;
  /** Its indexes, by name, for types only: never set. */
  readonly "~indexes"?: Indexes;
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

type IsReservedFieldName<Name> = Name extends `_${string}`
  ? true
  : Name extends string
    ? Uppercase<Name> extends "AND" | "OR" | "NOT"
      ? true
      : false
    : false;

/**
 * The names among `Fields` an author can't use: the managed fields'
 * prefix, and a filter's operators in any case.
 */
type ReservedFieldNames<Fields> = {
  [Key in keyof Fields]: IsReservedFieldName<Key> extends true ? Key : never;
}[keyof Fields];

/** Levels of a value `ReferencedIn` has gone into. */
type Depth = readonly unknown[];

/**
 * The tables the record IDs within a value name. A record ID is a branded
 * string (`Id`), so an object that merely has a `__tableName` field isn't
 * one. It looks as deep as a value can nest (`valueLimits.depth`), so no
 * definable `v.id` is out of its sight.
 */
type ReferencedIn<Value, Seen extends Depth = []> = Seen["length"] extends 32
  ? never
  : Value extends string & { readonly __tableName: infer TableName }
    ? TableName
    : Value extends string | number | boolean | null | undefined
      ? never
      : Value extends readonly (infer Item)[]
        ? ReferencedIn<Item, [...Seen, unknown]>
        : Value extends object
          ? {
              [Key in keyof Value]-?: ReferencedIn<
                Value[Key],
                [...Seen, unknown]
              >;
            }[keyof Value]
          : never;

/** The tables the record IDs in a schema's fields name. */
type ReferencedTables<Tables> = {
  [Table in keyof Tables]: Tables[Table] extends {
    readonly fields: infer Fields extends ValueShape;
  }
    ? { [Key in keyof Fields]: ReferencedIn<Infer<Fields[Key]>> }[keyof Fields]
    : never;
}[keyof Tables];

/** Fails to type-check when a `v.id` names a table the schema hasn't. */
type KnownReferences<Tables> = [
  Exclude<ReferencedTables<Tables>, keyof Tables>,
] extends [never]
  ? unknown
  : {
      readonly "v.id names a table this schema doesn't have": Exclude<
        ReferencedTables<Tables>,
        keyof Tables
      >;
    };

/** A table as its schema's manifest reads it: descriptors, not schemas. */
export interface TableState {
  readonly fields: Readonly<Record<string, ValueDescriptor>>;
  readonly indexes: readonly IndexDefinition[];
}

/** Every table `defineTable` made; nothing else is one. */
const tableStates = new WeakMap<object, TableState>();

/** Every schema `defineSchema` made; nothing else is one. */
const schemaStates = new WeakMap<
  object,
  Readonly<Record<string, TableState>>
>();

/**
 * A map's own entries, read once into a frozen copy: every check after
 * reads the copy, so a getter can't answer one thing to the check and
 * another to what is kept.
 */
const snapshot = <Value>(
  map: Readonly<Record<string, Value>>
): Readonly<Record<string, Value>> => {
  const copy: Record<string, Value> = {};
  for (const [key, value] of Object.entries(map)) {
    // Defined, not assigned: no key can reach the prototype.
    Object.defineProperty(copy, key, { enumerable: true, value });
  }
  return Object.freeze(copy);
};

/** A table, field or index name, checked; `what` says which, for the message. */
const checkedName = (name: unknown, what: string): string => {
  if (
    typeof name !== "string" ||
    name.length > schemaLimits.nameLength ||
    !storeNamePattern.test(name)
  ) {
    return refuse(
      "schema.invalid_name",
      `A ${what} name is a letter, then at most ${schemaLimits.nameLength - 1} letters, digits or underscores.`
    );
  }
  return name;
};

/**
 * Names that collide when case is ignored, which a store's host (and the
 * SQL it is free to generate) can't tell apart.
 */
const checkUnique = (names: readonly string[], what: string): void => {
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      refuse(
        "schema.name_conflict",
        `Two ${what} names differ only in case: \`${name}\`.`
      );
    }
    seen.add(key);
  }
};

export type IndexBase = "string" | "number" | "boolean";

/** The base type of each kind whose values are all of one scalar type. */
const scalarBases: Readonly<
  Partial<Record<ValueDescriptor["kind"], IndexBase>>
> = {
  boolean: "boolean",
  duration: "number",
  enum: "string",
  id: "string",
  model: "string",
  number: "number",
  person: "string",
  string: "string",
  template: "string",
  timestamp: "number",
};

/** Whether a descriptor allows only null: a union member an index skips. */
const isNullOnly = (descriptor: ValueDescriptor): boolean =>
  descriptor.kind === "null" ||
  (descriptor.kind === "literal" && descriptor.value === null);

/**
 * The one base type an index key of this descriptor has: a scalar, of one
 * base type whatever its members, with null and absence besides. Undefined
 * for anything else, which no index may name.
 */
export const indexBase = (
  descriptor: ValueDescriptor
): IndexBase | undefined => {
  if (descriptor.kind === "literal") {
    const type = typeof descriptor.value;
    return type === "string" || type === "number" || type === "boolean"
      ? type
      : undefined;
  }
  if (descriptor.kind === "union") {
    const bases = new Set(
      descriptor.members
        .filter((member) => !isNullOnly(member))
        .map((member) => indexBase(member))
    );
    const [base, ...others] = bases;
    return others.length === 0 ? base : undefined;
  }
  return scalarBases[descriptor.kind];
};

/** The fields of a new index, checked against its table. */
const checkedIndexFields = (
  state: TableState,
  name: string,
  keys: unknown
): readonly string[] => {
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.length > schemaLimits.fieldsPerIndex
  ) {
    return refuse(
      "schema.invalid_index",
      `Index \`${name}\` names between 1 and ${schemaLimits.fieldsPerIndex} fields.`
    );
  }
  const fields: string[] = [];
  for (const key of keys) {
    const field =
      typeof key === "string" && Object.hasOwn(state.fields, key)
        ? state.fields[key]
        : undefined;
    const isKey =
      indexableManaged.has(key) ||
      (field !== undefined && indexBase(field) !== undefined);
    if (typeof key !== "string" || !isKey) {
      return refuse(
        "schema.invalid_index",
        `Index \`${name}\` names a field that isn't a scalar field of the table, \`_createdAt\` or \`_updatedAt\`.`
      );
    }
    if (fields.includes(key)) {
      return refuse(
        "schema.invalid_index",
        `Index \`${name}\` names \`${key}\` twice.`
      );
    }
    fields.push(key);
  }
  const same = state.indexes.find(
    (index) =>
      index.fields.length === fields.length &&
      index.fields.every((field, position) => field === fields[position])
  );
  if (same !== undefined) {
    refuse(
      "schema.invalid_index",
      `Index \`${name}\` orders by the same fields as \`${same.name}\`.`
    );
  }
  return Object.freeze(fields);
};

/**
 * A table of these fields and indexes, registered as genuine. Typed as any
 * table: what `.index` answers is typed by `TableDefinition`.
 */
const tableOf = (shape: ValueShape, state: TableState): AnyTable => {
  const table = Object.freeze({
    fields: shape,
    indexes: state.indexes,
    index: (name: unknown, keys: unknown) => {
      const indexName = checkedName(name, "index");
      checkUnique(
        [...state.indexes.map((index) => index.name), indexName],
        "index"
      );
      if (state.indexes.length >= schemaLimits.indexesPerTable) {
        refuse(
          "schema.too_large",
          `A table has at most ${schemaLimits.indexesPerTable} indexes.`
        );
      }
      const fields = checkedIndexFields(state, indexName, keys);
      return tableOf(shape, {
        fields: state.fields,
        indexes: Object.freeze([
          ...state.indexes,
          Object.freeze({ name: indexName, fields }),
        ]),
      });
    },
  });
  tableStates.set(table, state);
  return table;
};

/**
 * A table of `fields`: a map of field names to `v` schemas, which may be
 * shared with operations' arguments. Field names are identifiers, never
 * starting with `_` (the managed fields are the host's) nor a filter's
 * `AND`, `OR` or `NOT`, and distinct ignoring case. Chain `.index(name,
 * fields)` for each index. Throws `SchemaDefinitionError` (or
 * `ValueDefinitionError`, for fields that aren't `v` schemas) otherwise.
 */
export const defineTable = <const Fields extends ValueShape>(
  fields: Fields & Readonly<Record<ReservedFieldNames<Fields>, never>>
): TableDefinition<Fields> => {
  if (!isPlainObject(fields)) {
    return refuse(
      "schema.invalid_table",
      "A table's fields are a map of names to schemas."
    );
  }
  const shape = snapshot(fields);
  const names = Object.keys(shape);
  for (const name of names) {
    checkedName(name, "field");
    if (filterOperators.has(name.toLowerCase())) {
      refuse(
        "schema.invalid_name",
        `\`${name}\` is a query filter's operator, so it can't be a field.`
      );
    }
  }
  checkUnique(names, "field");
  const descriptors = fieldDescriptors(shape);
  // Sealed as one object, so the table's whole document is within the
  // limits of one schema; the descriptors are those of the fields kept.
  const document = seal({
    descriptorVersion,
    fields: descriptors,
    kind: "object",
    nullable: false,
    presence: "required",
  });
  if (document.kind !== "object") {
    throw new Error("A sealed object descriptor isn't an object");
  }
  // SAFETY: the table's shape is `fields` itself, copied and frozen, it
  // has no indexes yet, and its `index` checks at run time what
  // `TableDefinition` types: index fields of the table, by a new name.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return tableOf(shape, {
    fields: document.fields,
    indexes: Object.freeze([]),
  }) as TableDefinition<Fields>;
};

/** The descriptors nested directly in `descriptor`. */
const childrenOf = (
  descriptor: ValueDescriptor
): readonly ValueDescriptor[] => {
  if (descriptor.kind === "object") {
    return Object.values(descriptor.fields);
  }
  if (descriptor.kind === "array") {
    return [descriptor.item];
  }
  if (descriptor.kind === "record") {
    return [descriptor.value];
  }
  return descriptor.kind === "union" ? descriptor.members : [];
};

/** Calls `visit` with the table each record ID within `descriptor` names. */
const forEachReference = (
  descriptor: ValueDescriptor,
  visit: (tableName: string) => void
): void => {
  if (descriptor.kind === "id") {
    visit(descriptor.tableName);
  }
  for (const child of childrenOf(descriptor)) {
    forEachReference(child, visit);
  }
};

/**
 * A schema of `tables`, each made with `defineTable` and named by its key:
 * an identifier, distinct from the others ignoring case, at most
 * `schemaLimits.tables` of them. Every `v.id(table)` in a field must name
 * one of these tables. No tables is a schema too: one that needs no store.
 * Throws `SchemaDefinitionError` otherwise.
 */
export const defineSchema = <
  const Tables extends Readonly<Record<string, AnyTable>>,
>(
  tables: Tables & KnownReferences<Tables>
): SchemaDefinition<Tables> => {
  if (!isPlainObject(tables)) {
    return refuse(
      "schema.invalid_table",
      "A schema's tables are a map of names to tables."
    );
  }
  // Counted before any is read.
  if (Object.keys(tables).length > schemaLimits.tables) {
    refuse(
      "schema.too_large",
      `A schema has at most ${schemaLimits.tables} tables.`
    );
  }
  const copy = snapshot<unknown>(tables);
  const names = Object.keys(copy);
  // Again on the copy, which is what is kept: a proxy can list other keys
  // the second time it is asked.
  if (names.length > schemaLimits.tables) {
    refuse(
      "schema.too_large",
      `A schema has at most ${schemaLimits.tables} tables.`
    );
  }
  const states: Record<string, TableState> = {};
  for (const name of names) {
    checkedName(name, "table");
    const table = copy[name];
    const state =
      typeof table === "object" && table !== null
        ? tableStates.get(table)
        : undefined;
    if (state === undefined) {
      return refuse(
        "schema.invalid_table",
        `Table \`${name}\` isn't one \`defineTable\` made.`
      );
    }
    Object.defineProperty(states, name, { enumerable: true, value: state });
  }
  checkUnique(names, "table");
  for (const [name, state] of Object.entries(states)) {
    for (const field of Object.values(state.fields)) {
      forEachReference(field, (target) => {
        if (!Object.hasOwn(states, target)) {
          refuse(
            "schema.unknown_table",
            `A record ID in table \`${name}\` names table \`${target}\`, which this schema doesn't have.`
          );
        }
      });
    }
  }
  // SAFETY: the copy holds exactly the tables passed, each checked to be
  // one `defineTable` made.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const schema = Object.freeze({ tables: copy }) as SchemaDefinition<Tables>;
  schemaStates.set(schema, Object.freeze(states));
  return schema;
};

/**
 * The tables of a schema `defineSchema` made, as descriptors: what its
 * manifest is made of (schema-manifest.ts). Throws for anything else, so
 * nothing but a checked schema becomes a manifest.
 */
export const tablesOf = (
  schema: unknown
): Readonly<Record<string, TableState>> => {
  const states =
    typeof schema === "object" && schema !== null
      ? schemaStates.get(schema)
      : undefined;
  return (
    states ??
    refuse("schema.invalid_table", "A schema is one `defineSchema` made.")
  );
};
