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
// Each place in a record that holds a record ID is one reference, checked
// on its own: references are never merged across fields or places, even
// when they hold the same ID. A union is read as the SDK's validator reads
// it: its members in order, the value belonging to the first that accepts
// it, and only that member is descended into, objects and arrays
// included. When that member is a `v.id`, every `v.id` member accepting
// the value is a table the reference may name (a record ID's shape doesn't
// say which); the store host keeps the one that holds the record
// (`#indexReferences`).

/**
 * One place in a record holding a record ID: the ID, and each table it may
 * name (one, unless a union of `v.id` members offers several).
 */
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
    const first = descriptor.members.findIndex((member) =>
      validates(member, value)
    );
    const matched = descriptor.members[first];
    if (matched === undefined) {
      return;
    }
    if (matched.kind !== "id") {
      referencesIn(matched, value, found);
      return;
    }
    if (typeof value === "string") {
      found.push({
        id: value,
        tables: descriptor.members
          .slice(first)
          .flatMap((member) =>
            member.kind === "id" && validates(member, value)
              ? [member.tableName]
              : []
          ),
      });
    }
  }
};

/**
 * The references a record with `fields` makes, under its table's field
 * descriptors `table`: one for each place holding a record ID, in field
 * order, never merged.
 */
export const recordReferences = (
  table: Readonly<Record<string, ValueDescriptor>>,
  fields: StoreFields
): RecordReference[] => {
  const found: RecordReference[] = [];
  for (const [name, field] of Object.entries(table)) {
    referencesIn(field, fields[name], found);
  }
  return found;
};
