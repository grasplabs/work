import {
  cursorMaxLength,
  queryDefaultPageSize,
  queryMaxScannedEntries,
  searchMaxTerms,
  searchTextMaxLength,
} from "@grasp-os/shared/store-limits";
import { searchTerms } from "@grasp-os/shared/store-reads";
import type { QueryTerminal } from "@grasp-os/shared/store-reads";

import { refuse } from "./query-error.ts";
import { baseOf, hasOnly } from "./query-values.ts";
import { relationOf } from "./schema-fields.ts";
import type { TableState } from "./schema-types.ts";

/**
 * A count a terminal takes, checked: a whole number from `min` up to the
 * most records one read may examine, which no terminal answers past.
 */
export const checkedCount = (
  value: unknown,
  min: number,
  what: string
): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > queryMaxScannedEntries
  ) {
    return refuse(
      "query.invalid_terminal",
      `${what} is a whole number from ${min} to ${queryMaxScannedEntries}.`
    );
  }
  return value;
};

/** The fields `.with` adds to `related`, checked: relations of the table. */
export const relatedOf = (
  table: TableState,
  related: readonly string[],
  fields: readonly unknown[]
): readonly string[] => {
  const all = [...related];
  for (const field of fields) {
    const descriptor =
      typeof field === "string" && Object.hasOwn(table.fields, field)
        ? table.fields[field]
        : undefined;
    if (
      typeof field !== "string" ||
      descriptor === undefined ||
      relationOf(descriptor) === undefined
    ) {
      return refuse(
        "query.invalid_terminal",
        "`.with` names fields of the table that hold a record ID (`v.id`) or a list of them."
      );
    }
    if (!all.includes(field)) {
      all.push(field);
    }
  }
  if (all.length === 0) {
    return refuse(
      "query.invalid_terminal",
      "`.with` names at least one field."
    );
  }
  return Object.freeze(all);
};

/** The declared numeric fields an aggregate list names, checked. */
const numericFieldsOf = (
  table: TableState,
  value: unknown,
  what: string
): string[] => {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every(
      (field) =>
        typeof field === "string" &&
        Object.hasOwn(table.fields, field) &&
        baseOf(table, field) === "number"
    )
  ) {
    return refuse(
      "query.invalid_terminal",
      `\`group\`'s \`${what}\` lists declared numeric fields of the table.`
    );
  }
  // Each field once: the host refuses a list that names one twice.
  return [...new Set(value.map(String))];
};

/** The terminal `group(options)` asks for, checked. */
export const groupTerminal = (
  table: TableState,
  options: unknown
): QueryTerminal => {
  if (!hasOnly(options, ["by", "sum", "avg", "min", "max"])) {
    return refuse(
      "query.invalid_terminal",
      "`group` takes `{ by, sum?, avg?, min?, max? }`."
    );
  }
  const { by } = options;
  if (
    !Array.isArray(by) ||
    by.length === 0 ||
    new Set(by).size !== by.length ||
    !by.every(
      (field) =>
        typeof field === "string" &&
        Object.hasOwn(table.fields, field) &&
        baseOf(table, field) !== undefined
    )
  ) {
    return refuse(
      "query.invalid_terminal",
      "`group` groups by one or more different scalar fields of the table."
    );
  }
  return {
    kind: "group",
    by: by.map(String),
    sum: numericFieldsOf(table, options.sum, "sum"),
    avg: numericFieldsOf(table, options.avg, "avg"),
    min: numericFieldsOf(table, options.min, "min"),
    max: numericFieldsOf(table, options.max, "max"),
  };
};

/** The text `search` looks for, checked. */
export const searchTextOf = (text: unknown): string => {
  if (typeof text !== "string" || text.length > searchTextMaxLength) {
    return refuse(
      "query.invalid_terminal",
      `A search's text is a string of at most ${searchTextMaxLength} characters.`
    );
  }
  if (searchTerms(text).length > searchMaxTerms) {
    return refuse(
      "query.invalid_terminal",
      `A search looks for at most ${searchMaxTerms} words.`
    );
  }
  return text;
};

/** The terminal `aggregate(options)` asks for, checked. */
export const aggregateTerminal = (
  table: TableState,
  options: unknown
): QueryTerminal => {
  if (hasOnly(options, ["operation"]) && options.operation === "count") {
    return { kind: "aggregate", operation: "count" };
  }
  if (!hasOnly(options, ["operation", "field"])) {
    return refuse(
      "query.invalid_terminal",
      "`aggregate` takes `{ operation }` for a count, `{ operation, field }` otherwise."
    );
  }
  const { operation, field } = options;
  if (operation !== "sum" && operation !== "min" && operation !== "max") {
    return refuse(
      "query.invalid_terminal",
      "`aggregate` takes `count`, `sum`, `min` or `max`; a count names no field."
    );
  }
  if (
    typeof field !== "string" ||
    !Object.hasOwn(table.fields, field) ||
    baseOf(table, field) !== "number"
  ) {
    return refuse(
      "query.invalid_terminal",
      "`sum`, `min` and `max` take a declared numeric field of the table."
    );
  }
  return { kind: "aggregate", operation, field };
};

/** A cursor `paginate` takes, checked: null is `nullMeans`. */
const checkedCursor = (cursor: unknown, nullMeans: string): string | null => {
  if (
    cursor !== null &&
    (typeof cursor !== "string" ||
      cursor === "" ||
      cursor.length > cursorMaxLength)
  ) {
    return refuse(
      "query.invalid_terminal",
      `A cursor is a non-empty string of at most ${cursorMaxLength} characters, or null ${nullMeans}.`
    );
  }
  return cursor;
};

/** The terminal `paginate(options)` asks for, checked. */
export const pageTerminal = (options: unknown): QueryTerminal => {
  if (!hasOnly(options, ["pageSize", "cursor", "endCursor"])) {
    return refuse(
      "query.invalid_terminal",
      "`paginate` takes `{ pageSize, cursor, endCursor }`."
    );
  }
  const {
    pageSize = queryDefaultPageSize,
    cursor = null,
    endCursor = null,
  } = options;
  return {
    kind: "paginate",
    pageSize: checkedCount(pageSize, 1, "`pageSize`"),
    cursor: checkedCursor(cursor, "for the first page"),
    endCursor: checkedCursor(endCursor, "for a page that ends where it may"),
  };
};
