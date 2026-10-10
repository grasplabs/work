import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";

/**
 * The manifest text of a schema of tables `names`, each with a `title`, as
 * core hands a store's object a schema to define its tables from.
 */
export const tablesManifest = (...names: readonly string[]): string =>
  manifestText(
    schemaManifest(
      defineSchema(
        Object.fromEntries(
          names.map((name) => [name, defineTable({ title: v.string() })])
        )
      )
    )
  );
