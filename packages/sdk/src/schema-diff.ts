import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import type {
  ManifestAccess,
  ManifestTable,
  SchemaManifest,
} from "./schema-manifest.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

// What changed between two versions of a schema, read from their canonical
// manifests: every table, field, index and access mode added, removed or
// changed, each with what it was and what it is. It is structure, not a
// summary, so what plans a schema change (which changes are safe to apply
// on their own, which need a migration) decides from the descriptors
// themselves. It decides nothing itself.
//
// Adapted from Baseflare's `diffSchemaManifests` (MIT, © 2026 Baseflare
// contributors: packages/baseflare/src/server/schema/manifest.ts).

/** What happened to a table, field or index between two versions. */
export type SchemaChange = "added" | "removed" | "changed";

/** A table added or removed. */
export interface TableChange {
  readonly table: string;
  readonly change: "added" | "removed";
}

/** A field added, removed or changed: its descriptor before and after. */
export interface FieldChange {
  readonly table: string;
  readonly field: string;
  readonly change: SchemaChange;
  readonly before?: ValueDescriptor;
  readonly after?: ValueDescriptor;
}

/** An index added, removed or changed: its fields before and after. */
export interface IndexChange {
  readonly table: string;
  readonly index: string;
  readonly change: SchemaChange;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

/** A table's access, before and after; one side is missing for a table added or removed. */
export interface AccessChange {
  readonly table: string;
  readonly before?: ManifestAccess;
  readonly after?: ManifestAccess;
}

/**
 * Everything that differs between two manifests, each list ordered by
 * table, then name. A table added or removed lists its fields, indexes and
 * access too.
 */
export interface SchemaDiff {
  readonly hasChanges: boolean;
  readonly tables: readonly TableChange[];
  readonly fields: readonly FieldChange[];
  readonly indexes: readonly IndexChange[];
  readonly access: readonly AccessChange[];
}

/** By UTF-16 code unit, as canonical JSON orders keys: never by locale. */
const byCodeUnit = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** The names in either map, in order. */
const namesOf = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>
): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted(
    byCodeUnit
  );

const own = <Value>(
  map: Readonly<Record<string, Value>>,
  name: string
): Value | undefined => (Object.hasOwn(map, name) ? map[name] : undefined);

/** A part of a manifest in canonical JSON. */
const canonical = (value: unknown): string => {
  // SAFETY: parsing JSON text always gives a JSON value; manifests hold
  // nothing JSON loses.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, unicorn/prefer-structured-clone -- see SAFETY; not a clone, a reading as JSON
  const json = JSON.parse(JSON.stringify(value)) as Json;
  return canonicalJson(json);
};

/** Whether two parts of manifests say the same. */
const same = (before: unknown, after: unknown): boolean =>
  canonical(before) === canonical(after);

/** How a named part changed, if it did. */
const changeOf = (
  before: unknown,
  after: unknown
): SchemaChange | undefined => {
  if (before === undefined) {
    return after === undefined ? undefined : "added";
  }
  if (after === undefined) {
    return "removed";
  }
  return same(before, after) ? undefined : "changed";
};

const emptyTable: ManifestTable = {
  fields: {},
  indexes: {},
  access: {
    read: "none",
    write: "none",
  },
};

/** What differs in one table, which may exist on one side only. */
const diffTable = (
  table: string,
  before: ManifestTable | undefined,
  after: ManifestTable | undefined,
  diff: {
    fields: FieldChange[];
    indexes: IndexChange[];
    access: AccessChange[];
  }
): void => {
  const was = before ?? emptyTable;
  const is = after ?? emptyTable;
  for (const field of namesOf(was.fields, is.fields)) {
    const old = own(was.fields, field);
    const now = own(is.fields, field);
    const change = changeOf(old, now);
    if (change !== undefined) {
      diff.fields.push({
        table,
        field,
        change,
        ...(old === undefined ? {} : { before: old }),
        ...(now === undefined ? {} : { after: now }),
      });
    }
  }
  for (const index of namesOf(was.indexes, is.indexes)) {
    const old = own(was.indexes, index)?.fields;
    const now = own(is.indexes, index)?.fields;
    const change = changeOf(old, now);
    if (change !== undefined) {
      diff.indexes.push({
        table,
        index,
        change,
        ...(old === undefined ? {} : { before: old }),
        ...(now === undefined ? {} : { after: now }),
      });
    }
  }
  if (
    before === undefined ||
    after === undefined ||
    !same(was.access, is.access)
  ) {
    diff.access.push({
      table,
      ...(before === undefined ? {} : { before: before.access }),
      ...(after === undefined ? {} : { after: after.access }),
    });
  }
};

/**
 * What changed from `before` to `after`. Both are canonical manifests
 * (made by `schemaManifest`, or read by `readSchemaManifest`), so keys
 * declared in another order are no change, and a field's default,
 * constraint or presence, an index's field order and a table's access
 * mode are.
 */
export const diffSchemaManifests = (
  before: SchemaManifest,
  after: SchemaManifest
): SchemaDiff => {
  const tables: TableChange[] = [];
  const fields: FieldChange[] = [];
  const indexes: IndexChange[] = [];
  const access: AccessChange[] = [];
  const parts = { fields, indexes, access };
  for (const table of namesOf(before.tables, after.tables)) {
    const old = own(before.tables, table);
    const now = own(after.tables, table);
    if (old === undefined) {
      tables.push({ table, change: "added" });
    } else if (now === undefined) {
      tables.push({ table, change: "removed" });
    }
    diffTable(table, old, now, parts);
  }
  return {
    hasChanges:
      tables.length > 0 ||
      parts.fields.length > 0 ||
      parts.indexes.length > 0 ||
      parts.access.length > 0,
    tables,
    ...parts,
  };
};

/**
 * One step from a field to a record ID within it: into an object's field,
 * an array's items or a record's values. A union's members are at the
 * same place as the union.
 */
export type ReferenceStep =
  | { readonly kind: "field"; readonly name: string }
  | { readonly kind: "item" }
  | { readonly kind: "value" };

/**
 * A record ID a table declares (`v.id(target)`): which table holds it,
 * where in a record it is, and which table it names. What a record's
 * deletion must check before it goes.
 */
export interface SchemaReference {
  readonly table: string;
  readonly path: readonly ReferenceStep[];
  readonly target: string;
}

/** The references within `descriptor`, at `path`. */
const referencesIn = (
  descriptor: ValueDescriptor,
  path: readonly ReferenceStep[],
  found: (path: readonly ReferenceStep[], target: string) => void
): void => {
  if (descriptor.kind === "id") {
    found(path, descriptor.tableName);
  } else if (descriptor.kind === "object") {
    // In name order, as canonical JSON has them.
    for (const name of Object.keys(descriptor.fields).toSorted(byCodeUnit)) {
      const field = descriptor.fields[name];
      if (field !== undefined) {
        referencesIn(field, [...path, { kind: "field", name }], found);
      }
    }
  } else if (descriptor.kind === "array") {
    referencesIn(descriptor.item, [...path, { kind: "item" }], found);
  } else if (descriptor.kind === "record") {
    referencesIn(descriptor.value, [...path, { kind: "value" }], found);
  } else if (descriptor.kind === "union") {
    for (const member of descriptor.members) {
      referencesIn(member, path, found);
    }
  }
};

/**
 * Every record ID the manifest's tables declare, ordered by table, then
 * field. A record ID always names a table of the same schema
 * (`defineSchema` refuses any other).
 */
export const schemaReferences = (
  manifest: SchemaManifest
): readonly SchemaReference[] => {
  const references: SchemaReference[] = [];
  // A union naming one table twice is one reference.
  const seen = new Set<string>();
  for (const table of Object.keys(manifest.tables).toSorted(byCodeUnit)) {
    const { fields } = manifest.tables[table] ?? emptyTable;
    for (const field of Object.keys(fields).toSorted(byCodeUnit)) {
      const descriptor = fields[field];
      if (descriptor !== undefined) {
        referencesIn(
          descriptor,
          [{ kind: "field", name: field }],
          (path, target) => {
            const key = JSON.stringify([table, path, target]);
            if (!seen.has(key)) {
              seen.add(key);
              references.push({ table, path, target });
            }
          }
        );
      }
    }
  }
  return references;
};
