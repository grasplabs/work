import { refuse } from "./schema-error.ts";
import { indexBase } from "./schema-fields.ts";
import { schemaLimits } from "./schema-limits.ts";
import type { TableState } from "./schema-types.ts";

/** The managed fields an index may name: the commit times. */
export type IndexableManagedField = "_createdAt" | "_updatedAt";

const indexableManaged: ReadonlySet<unknown> = new Set<IndexableManagedField>([
  "_createdAt",
  "_updatedAt",
]);

/** The fields of a new index, checked against its table. */
export const checkedIndexFields = (
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
export const checkedSearchFields = (
  state: TableState,
  keys: unknown
): readonly string[] => {
  if (!Array.isArray(keys) || keys.length === 0) {
    return refuse(
      "schema.invalid_index",
      "A search index covers one or more text fields."
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
