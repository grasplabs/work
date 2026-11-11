import { isPlainObject } from "@grasp-os/shared/json";

import { seal } from "./descriptor-seal.ts";
import { refuse } from "./schema-error.ts";
import { checkedIndexFields, checkedSearchFields } from "./schema-indexes.ts";
import { checkedName, checkUnique, schemaLimits } from "./schema-limits.ts";
import type { AnyTable, TableDefinition, TableState } from "./schema-types.ts";
import { fieldDescriptors } from "./sealed-descriptors.ts";
import { checkedAccess } from "./table-access.ts";
import { descriptorVersion } from "./value-descriptor.ts";
import type { ValueShape } from "./value-types.ts";

/**
 * The keys of a query filter's logic (`AND`, `OR`, `NOT`): never a field,
 * in any case, so a filter can't be read two ways.
 */
const filterOperators: ReadonlySet<string> = new Set(["and", "or", "not"]);

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

/** Every table `defineTable` made; nothing else is one. */
export const tableStates = new WeakMap<object, TableState>();

/**
 * A map's own entries, read once into a frozen copy: every check after
 * reads the copy, so a getter can't answer one thing to the check and
 * another to what is kept.
 */
export const snapshot = <Value>(
  map: Readonly<Record<string, Value>>
): Readonly<Record<string, Value>> => {
  const copy: Record<string, Value> = {};
  for (const [key, value] of Object.entries(map)) {
    // Defined, not assigned: no key can reach the prototype.
    Object.defineProperty(copy, key, { enumerable: true, value });
  }
  return Object.freeze(copy);
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
 * shared with functions' arguments. Field names are identifiers, never
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
