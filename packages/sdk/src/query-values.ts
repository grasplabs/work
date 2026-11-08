import { queryMaxStringLength } from "@grasp-os/shared/store-limits";

import { allowsNull, indexBase } from "./schema-fields.ts";
import type { IndexBase } from "./schema-fields.ts";
import type { TableState } from "./schema-types.ts";

/** The managed fields a read may compare, and the base type of each. */
const managedBases: Readonly<Record<string, IndexBase>> = {
  _id: "string",
  _ownerId: "string",
  _createdAt: "number",
  _updatedAt: "number",
};

/** The base type of a field a read may compare, or undefined. */
export const baseOf = (
  table: TableState,
  field: string
): IndexBase | undefined => {
  if (Object.hasOwn(managedBases, field)) {
    return managedBases[field];
  }
  const descriptor = Object.hasOwn(table.fields, field)
    ? table.fields[field]
    : undefined;
  return descriptor === undefined ? undefined : indexBase(descriptor);
};

/** Whether `field` of `table` may hold an explicit null. */
export const nullableField = (table: TableState, field: string): boolean => {
  const descriptor = Object.hasOwn(table.fields, field)
    ? table.fields[field]
    : undefined;
  return descriptor !== undefined && allowsNull(descriptor);
};

/**
 * Whether `value` is a scalar of base type `base`, or null where null is
 * allowed: a string within the length a descriptor carries.
 */
export const fits = (
  value: unknown,
  base: IndexBase,
  allowNull: boolean
): boolean => {
  if (value === null) {
    return allowNull;
  }
  if (base === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (base === "string") {
    return typeof value === "string" && value.length <= queryMaxStringLength;
  }
  return typeof value === base;
};

export const isPlainRecord = (
  value: unknown
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Whether `value` is a plain object with no keys but `allowed`. */
export const hasOnly = (
  value: unknown,
  allowed: readonly string[]
): value is Record<string, unknown> =>
  isPlainRecord(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
