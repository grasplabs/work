import { defineSchema, defineTable, v } from "@grasp-os/runtime";
import type { SchemaDefinition } from "@grasp-os/runtime";
import {
  manifestText,
  readSchemaManifest,
  schemaHash,
  schemaManifest,
} from "@grasp-os/runtime/host";
import type { AccessMode, SchemaManifest } from "@grasp-os/runtime/host";
import { mintRecordId } from "@grasp-os/shared/record-ids";
import type { WriterRoles } from "@grasp-os/shared/stores";

import type { SchemaIds } from "../src/schema-changes.ts";
import type { AppliedSchema, SchemaApply } from "../src/store-host.ts";

/**
 * The manifest text of a schema of tables `names`, each with a `title`, as
 * core hands a store's object a schema to define its tables from. Each
 * table is read and written by the App's members.
 */
export const tablesManifest = (...names: readonly string[]): string =>
  manifestText(
    schemaManifest(
      defineSchema(
        Object.fromEntries(
          names.map((name) => [
            name,
            defineTable({ title: v.string() }).access({
              read: "appMembers",
              write: "appMembers",
            }),
          ])
        )
      )
    )
  );

/** Access for a schema's tables by name: a table or mode left out is `none`. */
export interface TablesAccess {
  readonly tables: Readonly<
    Record<string, { readonly read?: AccessMode; readonly write?: AccessMode }>
  >;
}

/**
 * `schema`'s manifest, its tables given `declared` access, read back as a
 * store's host reads a manifest it is handed: checked as `.access` checks
 * a declaration.
 */
export const accessedManifest = (
  schema: SchemaDefinition,
  declared: TablesAccess
): SchemaManifest => {
  const base = schemaManifest(schema);
  return readSchemaManifest(
    JSON.stringify({
      ...base,
      tables: Object.fromEntries(
        Object.entries(base.tables).map(([name, table]) => {
          const held = Object.hasOwn(declared.tables, name)
            ? declared.tables[name]
            : undefined;
          return [
            name,
            {
              ...table,
              access: {
                read: held?.read ?? "none",
                write: held?.write ?? "none",
              },
            },
          ];
        })
      ),
    })
  ).manifest;
};

/** The hash a store computes of the manifest whose text is `text`. */
export const manifestHash = async (text: string): Promise<string> =>
  await schemaHash(readSchemaManifest(text).manifest);

/** A commit's roles for a member and builder of the App: every mode admits them. */
export const memberRoles: WriterRoles = { appMember: true, appBuilder: true };

/** A new record's ID, as core mints one for an insert. */
export const newRecordId = (): string => mintRecordId();

/** Each table's stable ID in these tests, by name: a UUID, as a definition's. */
const tableIds = new Map<string, string>();

/**
 * The stable IDs a definition would give the schema whose manifest is
 * `text`: each table one of its own, the same for its name in every test
 * of the file, and each field its name.
 */
export const namedIds = (text: string): SchemaIds => {
  let tables: SchemaManifest["tables"];
  try {
    ({ tables } = readSchemaManifest(text).manifest);
  } catch {
    // Text that isn't a manifest: the store refuses it.
    return {};
  }
  return Object.fromEntries(
    Object.entries(tables).map(([name, table]) => {
      const id = tableIds.get(name) ?? crypto.randomUUID();
      tableIds.set(name, id);
      return [
        name,
        {
          id,
          fields: Object.fromEntries(
            Object.keys(table.fields).map((field) => [field, field])
          ),
        },
      ];
    })
  );
};

/**
 * The schema whose manifest is `text` as a publish applies it
 * (`StoreHost.applySchema`), its IDs `namedIds`, applied for Ada.
 */
export const applied = (
  text: string,
  more: Partial<SchemaApply> = {}
): SchemaApply => ({
  manifest: text,
  ids: namedIds(text),
  actor: { type: "person", userId: "ada" },
  ...more,
});

/**
 * Applies the schema whose manifest is `text` to `store` (`applied`):
 * what it answered, and each of its tables' IDs by name.
 */
export const appliedTables = async (
  store: { applySchema: (change: SchemaApply) => Promise<AppliedSchema> },
  text: string
): Promise<AppliedSchema & { tables: Record<string, string> }> => {
  const answered = await store.applySchema(applied(text));
  return {
    ...answered,
    tables: Object.fromEntries(
      Object.entries(namedIds(text)).map(([name, { id }]) => [name, id])
    ),
  };
};
