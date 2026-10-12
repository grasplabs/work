import type { ValueDescriptor } from "@grasp-os/sdk";
import type { Json } from "@grasp-os/shared/json";
import type { StoreFields } from "@grasp-os/shared/stores";

// The references a record makes, read from its fields as the schema it was
// written under declares them: every `v.id("table")` field, at any depth
// (in objects, arrays, records and union members). The store host indexes
// them as it commits (store-host.ts), so deleting a record another refers
// to is refused in the same transaction (restrict).

/** One reference: the table a `v.id` field names, and the record ID it holds. */
export interface RecordReference {
  readonly table: string;
  readonly id: string;
}

/** Whether `value` is a JSON array. */
const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);

/** Whether `value` is a plain JSON object. */
const isObject = (value: Json): value is Readonly<Record<string, Json>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The references `value` makes under `descriptor`. A union reads each
 * member that could have taken the value: a string under every `v.id`
 * member, an object under every object or record member, an array under
 * every array member. Where a string could be a plain string or a
 * reference, it counts as a reference, so a deletion is refused rather
 * than a reference left dangling.
 */
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
      found.push({ table: descriptor.tableName, id: value });
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
    for (const member of descriptor.members) {
      referencesIn(member, value, found);
    }
  }
};

/**
 * The references a record with `fields` makes, under its table's field
 * descriptors `table`: each once.
 */
export const recordReferences = (
  table: Readonly<Record<string, ValueDescriptor>>,
  fields: StoreFields
): RecordReference[] => {
  const found: RecordReference[] = [];
  for (const [name, field] of Object.entries(table)) {
    referencesIn(field, fields[name], found);
  }
  const seen = new Set<string>();
  return found.filter((reference) => {
    const key = JSON.stringify([reference.table, reference.id]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};
