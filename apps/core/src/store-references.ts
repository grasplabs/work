import type { ValueDescriptor } from "@grasp-os/sdk";
import type { Json } from "@grasp-os/shared/json";
import type { StoreFields } from "@grasp-os/shared/stores";

import { validates } from "./store-queries.ts";

// The references a record makes, read from its fields as the store's
// contract declares them: every `v.id("table")` field, at any depth (in
// objects, arrays, records and union members). The store host indexes them
// as it commits (store-host.ts), so deleting a record another refers to is
// refused in the same transaction (restrict).
//
// A union is resolved by the member its value matches. A value one of its
// other members accepts (a literal, a string, an object) is that member's,
// so a union's string is a reference only when no member but its `v.id`
// ones accepts it. Several `v.id` members may accept the same string: the
// reference then names each of their tables, and the store host keeps
// only the table that holds the record (`#indexReferences`).

/** A record ID, and each table it may name: one, unless a union offers several. */
export interface RecordReference {
  readonly id: string;
  readonly tables: readonly string[];
}

/** Whether `value` is a JSON array. */
const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);

/** Whether `value` is a plain JSON object. */
const isObject = (value: Json): value is Readonly<Record<string, Json>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The references `value` makes under `descriptor`. */
const referencesIn = (
  descriptor: ValueDescriptor,
  value: Json | undefined,
  found: RecordReference[]
): void => {
  if (value === undefined || value === null) {
    return;
  }
  if (descriptor.kind === "id") {
    if (typeof value === "string") {
      found.push({ id: value, tables: [descriptor.tableName] });
    }
  } else if (descriptor.kind === "object") {
    if (isObject(value)) {
      for (const [name, field] of Object.entries(descriptor.fields)) {
        referencesIn(field, value[name], found);
      }
    }
  } else if (descriptor.kind === "record") {
    if (isObject(value)) {
      for (const entry of Object.values(value)) {
        referencesIn(descriptor.value, entry, found);
      }
    }
  } else if (descriptor.kind === "array") {
    if (isArray(value)) {
      for (const item of value) {
        referencesIn(descriptor.item, item, found);
      }
    }
  } else if (descriptor.kind === "union") {
    const accepting = descriptor.members.filter((member) =>
      validates(member, value)
    );
    const others = accepting.filter((member) => member.kind !== "id");
    if (others.length > 0) {
      for (const member of others) {
        referencesIn(member, value, found);
      }
      return;
    }
    const tables = accepting.flatMap((member) =>
      member.kind === "id" ? [member.tableName] : []
    );
    if (typeof value === "string" && tables.length > 0) {
      found.push({ id: value, tables });
    }
  }
};

/**
 * The references a record with `fields` makes, under its table's field
 * descriptors `table`: each record ID once, with every table any field
 * holding it may name.
 */
export const recordReferences = (
  table: Readonly<Record<string, ValueDescriptor>>,
  fields: StoreFields
): RecordReference[] => {
  const found: RecordReference[] = [];
  for (const [name, field] of Object.entries(table)) {
    referencesIn(field, fields[name], found);
  }
  const merged = new Map<string, Set<string>>();
  for (const { id, tables } of found) {
    const known = merged.get(id) ?? new Set<string>();
    for (const name of tables) {
      known.add(name);
    }
    merged.set(id, known);
  }
  return [...merged].map(([id, tables]) => ({ id, tables: [...tables] }));
};
