import { snapshot, tableStates } from "./define-table.ts";
import { refuse } from "./schema-error.ts";
import { checkedName, checkUnique, schemaLimits } from "./schema-limits.ts";
import type { AnyTable, SchemaDefinition, TableState } from "./schema-types.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import type { Infer, ValueShape } from "./value-types.ts";

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

/** Every schema `defineSchema` made; nothing else is one. */
const schemaStates = new WeakMap<
  object,
  Readonly<Record<string, TableState>>
>();

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
