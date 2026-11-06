import {
  indexMaxFields,
  searchIndexMaxFields,
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
// schema-manifest.ts) and what two versions are compared by. Who may read
// or write a table, and which of its rows, is declared on the table
// (`.access`, with `rows` for row rules), since its rules name its fields.
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
  fieldsPerIndex: indexMaxFields,
  /** Text fields in a table's search index. */
  fieldsPerSearchIndex: searchIndexMaxFields,
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
  | "schema.invalid_rules"
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

/**
 * A role in an App a row rule may name: `builder`, or `user`, which
 * everyone with a role in the App holds: its builders too, and whoever
 * calls the public operations of a store it serves (another App's or a
 * workflow's people, who are its members for those operations).
 */
export type RowRole = "builder" | "user";

/**
 * Who a row of a table reaches, for reading or for writing, as one rule:
 *
 * - `owner`: the person who inserted it (`_ownerId`);
 * - `person`: the person its `v.person()` field `field` names;
 * - `team`: a member of the team whose ID its text field `field` holds;
 * - `role`: whoever holds App role `role`, whatever the row holds.
 *
 * A row reaches whoever any of a table's rules admits.
 */
export type RowRule<Field extends string = string> =
  | { readonly kind: "owner" }
  | { readonly kind: "person"; readonly field: Field }
  | { readonly kind: "team"; readonly field: Field }
  | { readonly kind: "role"; readonly role: RowRole };

/** At least one rule, as a table's `.access` takes them. */
export type RowRuleList<Field extends string = string> = readonly [
  RowRule<Field>,
  ...RowRule<Field>[],
];

/** A table's row rules: for reading, writing, or both. */
export interface RowRules<Field extends string = string> {
  readonly read?: RowRuleList<Field>;
  readonly write?: RowRuleList<Field>;
}

/**
 * Who a table's records reach, for reading or for writing: only their
 * owner, the App's members, its builders, or nobody.
 */
export type AccessMode = "owner" | "appMembers" | "appBuilders" | "none";

export const accessModes: ReadonlySet<unknown> = new Set<AccessMode>([
  "owner",
  "appMembers",
  "appBuilders",
  "none",
]);

/**
 * A table's access, as `.access` takes it: a mode for reading and one for
 * writing (a mode left out is `none`), and the row rules that narrow them.
 */
export interface TableAccess<Field extends string = string> {
  readonly read?: AccessMode;
  readonly write?: AccessMode;
  readonly rows?: RowRules<Field>;
}

/** A table's access modes, both explicit. */
export interface AccessModes {
  readonly read: AccessMode;
  readonly write: AccessMode;
}

/** The most rules one direction of a table holds. */
export const rowRuleMax = 8;

/**
 * The rules a table's `.access` takes:
 *
 * ```ts
 * defineTable({ title: v.string(), assignee: v.person(), team: v.string() })
 *   .access({
 *     read: [rows.owner(), rows.person("assignee"), rows.team("team"), rows.role("builder")],
 *     write: [rows.owner(), rows.person("assignee"), rows.role("builder")],
 *   });
 * ```
 */
export const rows = Object.freeze({
  /** The person who inserted the row. */
  owner: (): RowRule<never> => Object.freeze({ kind: "owner" as const }),
  /** The person the row's `v.person()` field `field` names. */
  person: <const Field extends string>(field: Field): RowRule<Field> =>
    Object.freeze({ kind: "person" as const, field }),
  /** A member of the team whose ID the row's text field `field` holds. */
  team: <const Field extends string>(field: Field): RowRule<Field> =>
    Object.freeze({ kind: "team" as const, field }),
  /** Whoever holds App role `role`: `builder`, or `user` for everyone. */
  role: (role: RowRole): RowRule<never> =>
    Object.freeze({ kind: "role" as const, role }),
});

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
export type IndexMap = Readonly<Record<string, readonly string[]>>;

/** A table with no indexes yet. */
export type NoIndexes = Readonly<Record<never, readonly string[]>>;

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
  /** The text fields its search index covers, in order; none without one. */
  readonly searchIndex?: readonly string[];
  /** Declared sensitive (`TableDefinition.sensitive`); left out otherwise. */
  readonly sensitive?: true;
  /** Its access modes, as `.access` declared them; `none` both ways without. */
  readonly access?: AccessModes;
  /** Its row rules, as `.access` declared them (`rows`); none without. */
  readonly rules?: RowRules;
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

/**
 * The table a field of this descriptor relates to, and whether it holds a
 * list of IDs: a `v.id(table)`, or a `v.array(v.id(table))`, null and
 * absence allowed. Undefined for any other field, which `.with` can't
 * follow.
 */
export const relationOf = (
  descriptor: ValueDescriptor
): { readonly table: string; readonly many: boolean } | undefined => {
  if (descriptor.kind === "id") {
    return { table: descriptor.tableName, many: false };
  }
  if (descriptor.kind === "array" && descriptor.item.kind === "id") {
    return { table: descriptor.item.tableName, many: true };
  }
  return undefined;
};

/** Whether a field of this descriptor may hold an explicit null. */
export const allowsNull = (descriptor: ValueDescriptor): boolean => {
  if (descriptor.nullable || isNullOnly(descriptor)) {
    return true;
  }
  return descriptor.kind === "union" && descriptor.members.some(allowsNull);
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

/** The fields of a table's search index, checked against its table. */
const checkedSearchFields = (
  state: TableState,
  keys: unknown
): readonly string[] => {
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.length > schemaLimits.fieldsPerSearchIndex
  ) {
    return refuse(
      "schema.invalid_index",
      `A search index covers between 1 and ${schemaLimits.fieldsPerSearchIndex} text fields.`
    );
  }
  const fields: string[] = [];
  for (const key of keys) {
    const field =
      typeof key === "string" && Object.hasOwn(state.fields, key)
        ? state.fields[key]
        : undefined;
    if (
      typeof key !== "string" ||
      field === undefined ||
      indexBase(field) !== "string"
    ) {
      return refuse(
        "schema.invalid_index",
        "A search index covers text fields of the table: strings, enums of strings or templates."
      );
    }
    if (fields.includes(key)) {
      return refuse(
        "schema.invalid_index",
        `A search index names \`${key}\` twice.`
      );
    }
    fields.push(key);
  }
  return Object.freeze(fields);
};

const roleNames: ReadonlySet<unknown> = new Set<RowRole>(["builder", "user"]);

const isRowRole = (value: unknown): value is RowRole => roleNames.has(value);

const refuseRule = (message: string): never =>
  refuse("schema.invalid_rules", message);

/** A person or team rule's field, checked against its table. */
const checkedRuleField = (
  state: TableState,
  kind: "person" | "team",
  field: unknown
): string => {
  const descriptor =
    typeof field === "string" && Object.hasOwn(state.fields, field)
      ? state.fields[field]
      : undefined;
  if (typeof field !== "string" || descriptor === undefined) {
    return refuseRule(`A ${kind} rule names a field of its table.`);
  }
  if (kind === "person" && descriptor.kind !== "person") {
    return refuseRule(
      `A person rule names a \`v.person()\` field; \`${field}\` isn't one.`
    );
  }
  if (
    kind === "team" &&
    (descriptor.kind === "person" || indexBase(descriptor) !== "string")
  ) {
    return refuseRule(
      `A team rule names a text field holding a team's ID; \`${field}\` isn't one.`
    );
  }
  return field;
};

/** One row rule of unknown origin, checked against its table. */
const checkedRule = (state: TableState, rule: unknown): RowRule => {
  if (!isPlainObject(rule)) {
    return refuseRule("A row rule is one `rows` made.");
  }
  const keys = Object.keys(rule).toSorted().join(",");
  const { kind } = rule;
  if (kind === "owner" && keys === "kind") {
    return Object.freeze({ kind });
  }
  if (kind === "role" && keys === "kind,role") {
    const { role } = rule;
    if (!isRowRole(role)) {
      return refuseRule("A role rule names `builder` or `user`.");
    }
    return Object.freeze({ kind, role });
  }
  if ((kind === "person" || kind === "team") && keys === "field,kind") {
    return Object.freeze({
      kind,
      field: checkedRuleField(state, kind, rule.field),
    });
  }
  return refuseRule(
    "A row rule is `rows.owner()`, `rows.person(field)`, `rows.team(field)` or `rows.role(role)`."
  );
};

/** One direction's rules, checked: at least one, none twice. */
const checkedRuleList = (
  state: TableState,
  list: unknown
): RowRuleList | undefined => {
  if (list === undefined) {
    return undefined;
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > rowRuleMax) {
    return refuseRule(
      `Each direction of a table's rules lists between 1 and ${rowRuleMax} rules.`
    );
  }
  const seen = new Set<string>();
  const checked = list.map((rule: unknown) => {
    const one = checkedRule(state, rule);
    const key = JSON.stringify(one);
    if (seen.has(key)) {
      refuseRule("A table's rules name one rule twice.");
    }
    seen.add(key);
    return one;
  });
  const [first, ...others] = checked;
  if (first === undefined) {
    throw new Error("A checked rule list is empty");
  }
  return Object.freeze([first, ...others]);
};

/** A table's row rules of unknown origin, checked against it. */
const checkedRules = (state: TableState, rules: unknown): RowRules => {
  const known =
    isPlainObject(rules) &&
    Object.keys(rules).length > 0 &&
    Object.keys(rules).every((key) => key === "read" || key === "write");
  if (!known) {
    return refuseRule(
      "A table's rules are `{ read?, write? }`, at least one of them."
    );
  }
  const read = checkedRuleList(
    state,
    Object.hasOwn(rules, "read") ? rules.read : undefined
  );
  const write = checkedRuleList(
    state,
    Object.hasOwn(rules, "write") ? rules.write : undefined
  );
  return Object.freeze({
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
  });
};

/** A mode of unknown origin, checked: one left out is `none`. */
const checkedMode = (mode: unknown): AccessMode => {
  if (mode === undefined) {
    return "none";
  }
  if (!accessModes.has(mode)) {
    return refuse(
      "schema.invalid_access",
      "A table's `read` and `write` are each `owner`, `appMembers`, `appBuilders` or `none`."
    );
  }
  // SAFETY: one of the modes, checked just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return mode as AccessMode;
};

/**
 * A table's access of unknown origin, checked against it. Row rules choose
 * rows among those a mode lets someone reach, so a direction with rules
 * has a mode that reaches every row (`appMembers` or `appBuilders`):
 * `owner` already narrows to one person's rows (`rows.owner()` says it
 * among the rules), and `none` reaches no row.
 */
const checkedAccess = (
  state: TableState,
  access: unknown
): { access: AccessModes; rules?: RowRules } => {
  if (
    !isPlainObject(access) ||
    !Object.keys(access).every((key) => ["read", "write", "rows"].includes(key))
  ) {
    return refuse(
      "schema.invalid_access",
      "A table's access is `{ read?, write?, rows? }`."
    );
  }
  const modes: AccessModes = Object.freeze({
    read: checkedMode(access.read),
    write: checkedMode(access.write),
  });
  if (access.rows === undefined) {
    return { access: modes };
  }
  const rules = checkedRules(state, access.rows);
  for (const direction of ["read", "write"] as const) {
    const mode = modes[direction];
    if (
      rules[direction] !== undefined &&
      (mode === "owner" || mode === "none")
    ) {
      refuseRule(
        `A table with row rules for ${direction === "read" ? "reading" : "writing"} has \`${direction}\` access \`appMembers\` or \`appBuilders\`: the rules choose among the rows it reaches (\`rows.owner()\` among the rules says \`owner\`).`
      );
    }
  }
  return { access: modes, rules };
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
        ...state,
        indexes: Object.freeze([
          ...state.indexes,
          Object.freeze({ name: indexName, fields }),
        ]),
      });
    },
    searchIndex: (keys: unknown) => {
      if (state.searchIndex !== undefined) {
        refuse(
          "schema.invalid_index",
          "A table has one search index, over all the text fields it searches."
        );
      }
      return tableOf(shape, {
        ...state,
        searchIndex: checkedSearchFields(state, keys),
      });
    },
    sensitive: () => tableOf(shape, { ...state, sensitive: true }),
    access: (access: unknown) => {
      if (state.access !== undefined) {
        refuse("schema.invalid_access", "A table declares its access once.");
      }
      return tableOf(shape, { ...state, ...checkedAccess(state, access) });
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
