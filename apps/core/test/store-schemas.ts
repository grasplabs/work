import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import {
  manifestText,
  readSchemaManifest,
  schemaHash,
  schemaManifest,
} from "@grasp-os/sdk/host";
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
          names.map((name) => [name, defineTable({ title: v.string() })])
        )
      ),
      {
        tables: Object.fromEntries(
          names.map((name) => [
            name,
            { read: "appMembers", write: "appMembers" } as const,
          ])
        ),
      }
    )
  );

/** The hash a store computes of the manifest whose text is `text`. */
export const manifestHash = async (text: string): Promise<string> =>
  await schemaHash(readSchemaManifest(text).manifest);

/** A commit's roles for a member and builder of the App: every mode admits them. */
export const memberRoles: WriterRoles = { appMember: true, appBuilder: true };

/** A new record's ID, as core mints one for an insert. */
export const newRecordId = (): string => mintRecordId();
