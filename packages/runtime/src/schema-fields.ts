import type { ValueDescriptor } from "./value-descriptor.ts";

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
