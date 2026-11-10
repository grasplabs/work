import { canonicalText } from "@grasp-os/shared/json";

import { AppDefinitionError } from "./app-definition-error.ts";
import { refuser } from "./declaration.ts";
import { isMigration } from "./migration.ts";
import type { Migration, MigrationManifest } from "./migration.ts";
import type { SchemaManifest } from "./schema-manifest.ts";

const refuse: (message: string) => never = refuser(AppDefinitionError);

/** The most migrations an App registers. */
const appMaxMigrations = 16;

/**
 * The App's migrations, by name, in the order declared, each checked
 * against `schema`: a table it has, and an `output` declaring exactly that
 * table's fields, so what the host validates a transform's rows against
 * is the table the reviewer reads.
 */
export const migrationsOf = (
  migrations: unknown,
  schema: SchemaManifest
): {
  manifests: Record<string, MigrationManifest>;
  byName: Map<string, Migration>;
} => {
  const listed: readonly unknown[] = Array.isArray(migrations)
    ? migrations
    : [];
  if (
    (migrations !== undefined && !Array.isArray(migrations)) ||
    listed.length > appMaxMigrations
  ) {
    refuse(
      `An App's \`migrations\` is a list of at most ${appMaxMigrations} \`migration\` declarations.`
    );
  }
  const manifests: Record<string, MigrationManifest> = {};
  const byName = new Map<string, Migration>();
  for (const declared of listed) {
    if (!isMigration(declared)) {
      refuse("An App's `migrations` lists `migration` declarations only.");
    }
    const manifest = declared["~migration"];
    if (byName.has(manifest.name)) {
      refuse(`Two of the App's migrations are named \`${manifest.name}\`.`);
    }
    if (
      [...byName.values()].some(
        (other) => other["~migration"].table === manifest.table
      )
    ) {
      refuse(
        `Two of the App's migrations transform \`${manifest.table}\`: a table takes one migration a version.`
      );
    }
    const table = Object.hasOwn(schema.tables, manifest.table)
      ? schema.tables[manifest.table]
      : undefined;
    if (table === undefined) {
      refuse(
        `Migration \`${manifest.name}\` transforms \`${manifest.table}\`, a table the schema doesn't have.`
      );
    }
    if (
      manifest.output.kind !== "object" ||
      canonicalText(manifest.output.fields) !== canonicalText(table.fields)
    ) {
      refuse(
        `Migration \`${manifest.name}\`'s \`output\` doesn't declare exactly the fields of \`${manifest.table}\`: declare them as the schema does.`
      );
    }
    byName.set(manifest.name, declared);
    Object.defineProperty(manifests, manifest.name, {
      enumerable: true,
      value: manifest,
    });
  }
  return { manifests, byName };
};
