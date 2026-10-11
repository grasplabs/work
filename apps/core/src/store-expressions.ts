// The one place a business store's SQL names a field (store-host.ts): the
// expression for each field a read may order or compare by, shared by the
// index DDL (store-indexes.ts), index ranges, filters, ordering and cursor
// seeks. SQLite uses an expression index only for a query whose
// expression parses to the same expression as the index's, so every use
// must come from here, never be written out by hand.
//
// Managed fields are the fixed columns of `sdk_records`. A declared field
// is read from the record's JSON document, and three states stay apart:
// a field left out is SQL NULL; an explicit JSON null is the sentinel
// `-9e999` (SQLite's negative infinity, which no JSON number can be); a
// value is itself. So, ascending, a field left out sorts first, then
// null, then values (JSON numbers are finite, and every number sorts
// before every string in SQLite), and `= -9e999` finds explicit nulls
// only. That rests on no stored document holding a number that reads as
// negative infinity: a commit accepts finite numbers only (stores.ts),
// and canonical JSON writes them as JSON.stringify does, never as
// `-1e999`.
//
// Conditions are two-valued (shared/store-reads.ts gives their meaning):
// every condition's SQL is 0 or 1, never NULL, so `NOT` is plain negation
// and a field left out can't vanish through SQL's three-valued logic.
// Comparisons and `neq` match values only, guarded below by the field's
// base type (which excludes the sentinel and NULL) and, for numbers and
// booleans, above by `< ''` (which excludes text, sorting above every
// number); `eq` and `in` with null match the sentinel only; `in` binds its
// list as one JSON value, read with `json_each`, so its SQL stays flat
// however long the list; `exists` tests for NULL.
//
// No author's name becomes SQL unchecked: a field name must be an
// identifier (letters, digits and underscores, from a letter) and appears
// only inside a JSON path literal; a table ID is the host's own UUID.
// Values are always bound parameters.

import type {
  FilterCondition,
  FilterNode,
  QueryScalar,
  RangeBound,
} from "@grasp-os/shared/store-reads";
import { dataErrors } from "@grasp-os/shared/stores";

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
 * The term below every value of `base` in `expression`: what keeps a
 * comparison, or an upper bound alone, from matching null (the sentinel)
 * or a field left out (NULL), and a string from matching a number.
 */
const lowerGuard = (expression: string, base: ComparedBase): string =>
  base === "string" ? `${expression} >= ''` : `${expression} > ${nullSentinel}`;

/**
 * The term above every value of `base` in `expression`, if one is needed:
 * text sorts above every number in SQLite, so a number or boolean bounded
 * only below would match text; strings have nothing above them in JSON.
 */
const upperGuard = (
  expression: string,
  base: ComparedBase
): string | undefined => (base === "string" ? undefined : `${expression} < ''`);

/** The terms that keep only values of `base` in `expression`. */
const valuesOnly = (expression: string, base: ComparedBase): string =>
  [lowerGuard(expression, base), upperGuard(expression, base)]
    .filter((term) => term !== undefined)
    .join(" AND ");

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

/** SQL and its parameters, built together so they stay in step. */
export interface Fragment {
  readonly sql: string;
  readonly params: readonly (string | number | null)[];
}

/**
 * What a condition needs to know of the fields it names, from the pinned
 * schema: each one's base type (undefined: not a field a read compares),
 * and whether it may hold an explicit null.
 */
export interface FieldTypes {
  readonly base: (field: string) => ComparedBase | undefined;
  readonly nullable: (field: string) => boolean;
}

const invalid = (issue: string): Error =>
  dataErrors.create("data.invalid_query", { issues: [issue] });

/** Whether `value` is a scalar of `base`, or null where null is allowed. */
const fits = (
  value: QueryScalar,
  base: ComparedBase,
  allowNull: boolean
): boolean => (value === null ? allowNull : typeof value === base);

/** The base type of `field`, or `data.invalid_query`. */
const baseOf = (types: FieldTypes, field: string): ComparedBase => {
  const base = types.base(field);
  if (base === undefined) {
    throw invalid(`\`${field}\` isn't a scalar field of this table`);
  }
  return base;
};

/** `expression = value`; a null value is an explicit null. */
const equals = (expression: string, value: QueryScalar): Fragment =>
  value === null
    ? { sql: `${expression} = ${nullSentinel}`, params: [] }
    : { sql: `${expression} = ?`, params: [parameterOf(value)] };

const comparisons = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

/** One condition, as SQL that is always 0 or 1. */
const conditionSql = (types: FieldTypes, node: FilterCondition): Fragment => {
  const base = baseOf(types, node.field);
  const nullable = types.nullable(node.field);
  const expression = fieldExpression(node.field);
  if (node.op === "exists") {
    return {
      sql: `(${expression} IS ${node.value ? "NOT " : ""}NULL)`,
      params: [],
    };
  }
  if (node.op === "in") {
    if (!node.values.every((value) => fits(value, base, nullable))) {
      throw invalid(`\`${node.field}.in\` lists values of its type only`);
    }
    const values = node.values.filter((value) => value !== null);
    const terms: Fragment[] = [];
    if (values.length > 0) {
      // One JSON parameter, flat however long the list. `json_each`
      // reads numbers as numbers, strings as text and booleans as 1 and
      // 0, as `json_extract` does, so its values compare like the field's.
      terms.push({
        sql: `${expression} IN (SELECT value FROM json_each(?))`,
        params: [JSON.stringify(values)],
      });
    }
    if (values.length < node.values.length) {
      terms.push(equals(expression, null));
    }
    if (terms.length === 0) {
      return { sql: "0", params: [] };
    }
    return {
      sql: `IFNULL((${terms.map(({ sql }) => sql).join(" OR ")}), 0)`,
      params: terms.flatMap(({ params }) => params),
    };
  }
  const allowNull = (node.op === "eq" || node.op === "neq") && nullable;
  if (!fits(node.value, base, allowNull)) {
    throw invalid(`\`${node.field}.${node.op}\` takes a value of its type`);
  }
  if (node.op === "eq") {
    const term = equals(expression, node.value);
    return { sql: `IFNULL(${term.sql}, 0)`, params: term.params };
  }
  const domain = valuesOnly(expression, base);
  if (node.op === "neq") {
    // Values other than this one: never null, nor a field left out. Not
    // equal to null is any value.
    return node.value === null
      ? { sql: `IFNULL(${domain}, 0)`, params: [] }
      : {
          sql: `IFNULL((${expression} <> ? AND ${domain}), 0)`,
          params: [parameterOf(node.value)],
        };
  }
  return {
    sql: `IFNULL((${expression} ${comparisons[node.op]} ? AND ${domain}), 0)`,
    params: [parameterOf(node.value)],
  };
};

/**
 * A filter as one SQL term that is always 0 or 1, for a field's types as
 * `types` gives them; `data.invalid_query` for a field it doesn't compare
 * or a value not of its type.
 */
export const filterSql = (types: FieldTypes, node: FilterNode): Fragment => {
  if ("and" in node || "or" in node) {
    const children = "and" in node ? node.and : node.or;
    if (children.length === 0) {
      throw invalid("`and` and `or` hold at least one filter");
    }
    const parts = children.map((child) => filterSql(types, child));
    return {
      sql: `(${parts.map(({ sql }) => sql).join("and" in node ? " AND " : " OR ")})`,
      params: parts.flatMap(({ params }) => params),
    };
  }
  if ("not" in node) {
    const inner = filterSql(types, node.not);
    return { sql: `(NOT ${inner.sql})`, params: inner.params };
  }
  return conditionSql(types, node);
};

/**
 * The terms of one index field's bounds, for a WHERE clause SQLite reads
 * an index range from: equality (null only on a field that may hold it,
 * matching an explicit null), or a lower and/or upper bound, which match
 * values only (a bound on one side gets its base type's guard on the
 * other). Unlike a filter's, these terms aren't guarded against NULL: they
 * must stay top-level conjuncts of the WHERE clause, never under OR or
 * NOT (a cursor's seek included), where NULL would change what matches.
 */
export const rangeSql = (
  types: FieldTypes,
  field: string,
  bounds: readonly RangeBound[]
): Fragment => {
  const base = baseOf(types, field);
  const expression = fieldExpression(field);
  const terms: string[] = [];
  const params: (string | number | null)[] = [];
  for (const bound of bounds) {
    if (bound.op === "eq") {
      if (!fits(bound.value, base, types.nullable(field))) {
        throw invalid(`\`${field}\` is compared with a value of its type`);
      }
      const term = equals(expression, bound.value);
      terms.push(term.sql);
      params.push(...term.params);
    } else {
      if (!fits(bound.value, base, false)) {
        throw invalid(
          `\`${field}\` is bounded by a value of its type, never null`
        );
      }
      terms.push(`${expression} ${comparisons[bound.op]} ?`);
      params.push(parameterOf(bound.value));
    }
  }
  const lower = bounds.some(({ op }) => op === "gt" || op === "gte");
  const upper = bounds.some(({ op }) => op === "lt" || op === "lte");
  if (upper && !lower) {
    terms.push(lowerGuard(expression, base));
  }
  const above = upperGuard(expression, base);
  if (lower && !upper && above !== undefined) {
    terms.push(above);
  }
  return { sql: terms.join(" AND "), params };
};
