import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { SchemaDefinition } from "@grasp-os/sdk";
import {
  manifestText,
  readSchemaManifest,
  schemaHash,
  schemaManifest,
} from "@grasp-os/sdk/host";
import type { AccessMode, SchemaManifest } from "@grasp-os/sdk/host";
import { mintRecordId } from "@grasp-os/shared/record-ids";
import type { WriterRoles } from "@grasp-os/shared/stores";

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
