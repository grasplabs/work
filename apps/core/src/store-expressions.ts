// The one place a business store's SQL names a field (store-host.ts): the
// expression for each field a read may order or compare by, shared by the
// index DDL (store-indexes.ts), index ranges, filters, ordering and cursor
// seeks. SQLite matches an expression index by the text of its
// expression, so every use must come from here, character for character.
//
// Managed fields are the fixed columns of `sdk_records`. A declared field
// is read from the record's JSON document, and three states stay apart:
// a field left out is SQL NULL; an explicit JSON null is the sentinel
// `-9e999` (SQLite's negative infinity, which no JSON number can be); a
// value is itself. So, ascending, a field left out sorts first, then
// null, then values (JSON numbers are finite, and every number sorts
// before every string in SQLite), and `= -9e999` finds explicit nulls
// only. Comparisons match values only: `rangeTerms` and the filter
// compiler bound them below by the field's base type, which excludes the
// sentinel and NULL.
//
// No author's name becomes SQL unchecked: a field name must be an
// identifier (letters, digits and underscores, from a letter) and appears
// only inside a JSON path literal; a table ID is the host's own UUID.
// Values are always bound parameters.

/** The version of the expressions below: part of every index's definition. */
export const emitterVersion = 1;

/** The fixed column of each managed field a read may use. */
const managedColumns: Readonly<Record<string, string>> = {
  _id: "record_id",
  _ownerId: "owner_id",
  _rev: "revision",
  _createdAt: "created_at",
  _updatedAt: "updated_at",
};

/** What an explicit JSON null is in an expression: negative infinity. */
export const nullSentinel = "-9e999";

const declaredField = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** Whether `field` is one of the managed fields a read may use. */
export const isManagedField = (field: string): boolean =>
  Object.hasOwn(managedColumns, field);

/**
 * The SQL expression of `field`: its column for a managed field, its JSON
 * value (with null as the sentinel) for a declared one. Throws for a name
 * that isn't an identifier, which no checked descriptor holds.
 */
export const fieldExpression = (field: string): string => {
  const column = Object.hasOwn(managedColumns, field)
    ? managedColumns[field]
    : undefined;
  if (column !== undefined) {
    return column;
  }
  if (!declaredField.test(field)) {
    throw new Error("A field name reached SQL unchecked");
  }
  return `(CASE json_type(value_json, '$.${field}') WHEN 'null' THEN ${nullSentinel} ELSE json_extract(value_json, '$.${field}') END)`;
};

/** A host-minted table ID: a UUID, as `crypto.randomUUID` makes them. */
const tableIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * A table ID as a SQL literal, for a partial index's WHERE and the query
 * that must match it (SQLite proves a partial index usable from literals,
 * not parameters). Throws for anything but a host-minted UUID.
 */
export const tableIdLiteral = (tableId: string): string => {
  if (!tableIdPattern.test(tableId)) {
    throw new Error("A table ID isn't one the host minted");
  }
  return `'${tableId}'`;
};

/** A base type a read compares by: what values of a field may be. */
export type ComparedBase = "string" | "number" | "boolean";

/**
 * The SQL term that keeps only values of `base` in `expression`, below
 * every value of that type: for an upper bound without a lower one, so it
 * neither matches null (the sentinel) nor a field left out (NULL).
 */
export const valuesOnly = (expression: string, base: ComparedBase): string =>
  base === "string" ? `${expression} >= ''` : `${expression} > ${nullSentinel}`;

/** A scalar as a bound parameter: booleans as SQLite stores them. */
export const parameterOf = (
  value: string | number | boolean | null
): string | number | null => {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
};
