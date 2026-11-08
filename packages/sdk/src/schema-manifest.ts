import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalText } from "@grasp-os/shared/json";

import { isOverBytes, refuser } from "./declaration.ts";
import { tablesOf } from "./define-schema.ts";
import { SchemaDefinitionError } from "./schema-error.ts";
import type { SchemaDefinitionCode } from "./schema-error.ts";
import { managedFields } from "./schema-limits.ts";
import type { SchemaDefinition } from "./schema-types.ts";
import type { AccessModes, RowRules } from "./table-access.ts";
import { descriptorVersion } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

// A schema's canonical manifest: the one form of a schema that leaves the
// code that declared it. A store's host is handed it, a schema's hash is
// the SHA-256 of its canonical text, and two versions are compared by it.
//
// It holds everything that decides what a record may be and who may reach
// it: each table's field descriptors (defaults and constraints included),
// its indexes, in field order, its access modes and its row rules (only a
// table that declares them has them, so a table without keeps the
// manifest it had), with the versions of
// the manifest and descriptor formats and the managed fields the host
// adds. Its text is canonical (shared/json.ts): object keys sorted, arrays
// in order. So declaring fields, tables or indexes in another order hashes
// the same, while changing a default, a constraint, an index's field order
// or an access mode changes the hash and shows in the diff.
//
// A hash names a schema; it authorizes nothing.
//
// Adapted from Baseflare's schema manifest (MIT, © 2026 Baseflare
// contributors: packages/baseflare/src/server/schema/manifest.ts), with
// Grasp's access modes, versions and managed fields, a structural diff
// instead of display summaries, and a reading that treats its text as
// hostile.

/** The version of the manifest format below. */
export const manifestVersion = 1;

/**
 * The most bytes of a manifest's text, as UTF-8: checked before it is
 * parsed. The host's own bound until the runtime policy module sets one.
 */
export const manifestMaxBytes = 1024 * 1024;

/** A table's access as a manifest holds it: both modes, explicit. */
type ManifestAccess = AccessModes;

/** An index as a manifest holds it: its fields, in order. */
interface ManifestIndex {
  readonly fields: readonly string[];
}

/**
 * A table as a manifest holds it. `searchIndex` is there only for a table
 * that declares one, so a table without keeps the manifest it had.
 */
export interface ManifestTable {
  readonly fields: Readonly<Record<string, ValueDescriptor>>;
  readonly indexes: Readonly<Record<string, ManifestIndex>>;
  readonly searchIndex?: ManifestIndex;
  readonly access: ManifestAccess;
  /**
   * Declared sensitive (`TableDefinition.sensitive`): its change history
   * keeps field names only, and every read of it is recorded in the audit
   * log (who read, through which function, how many reads and records,
   * never the values). Left out otherwise, so a table that never
   * declares it hashes as it always did.
   */
  readonly sensitive?: true;
  /** Its row rules (`.access`), only for a table that declares them. */
  readonly rules?: RowRules;
}

/** A schema's canonical manifest. */
export interface SchemaManifest {
  readonly manifestVersion: typeof manifestVersion;
  readonly descriptorVersion: typeof descriptorVersion;
  readonly managedFields: typeof managedFields;
  readonly tables: Readonly<Record<string, ManifestTable>>;
}

const refuse: (code: SchemaDefinitionCode, message: string) => never = refuser(
  SchemaDefinitionError
);

/** A map of names an author or a manifest gave, without prototype keys. */
export const mapOf = <Value>(
  entries: Iterable<readonly [string, Value]>
): Record<string, Value> => {
  const map: Record<string, Value> = {};
  for (const [key, value] of entries) {
    // Defined, not assigned: no key can reach the prototype.
    Object.defineProperty(map, key, { enumerable: true, value });
  }
  return map;
};

/**
 * A manifest's canonical text: the same for the same schema and access,
 * whatever order they were declared in.
 */
// A manifest loses nothing through JSON: it holds names, strings, the
// versions and sealed descriptors, whose defaults are JSON.
export const manifestText = (manifest: SchemaManifest): string =>
  canonicalText(manifest);

/** A table's access where it declares none: nobody, both ways. */
const noAccess: ManifestAccess = Object.freeze({ read: "none", write: "none" });

/**
 * The canonical manifest of `schema`, made with `defineSchema`: every
 * table's access explicit (`.access`), `none` where it declares none.
 */
export const schemaManifest = (schema: SchemaDefinition): SchemaManifest => {
  const tables = tablesOf(schema);
  const manifest: SchemaManifest = {
    manifestVersion,
    descriptorVersion,
    managedFields,
    tables: mapOf(
      Object.entries(tables).map(([name, table]) => {
        const tableAccess = table.access ?? noAccess;
        return [
          name,
          {
            fields: table.fields,
            indexes: mapOf(
              table.indexes.map((index) => [
                index.name,
                { fields: index.fields },
              ])
            ),
            ...(table.searchIndex === undefined
              ? {}
              : { searchIndex: { fields: table.searchIndex } }),
            access: tableAccess,
            ...(table.sensitive === true ? { sensitive: true as const } : {}),
            ...(table.rules === undefined ? {} : { rules: table.rules }),
          },
        ];
      })
    ),
  };
  // A schema a store's host would refuse to read is refused here, where
  // it is declared.
  if (isOverBytes(manifestText(manifest), manifestMaxBytes)) {
    refuse(
      "schema.too_large",
      `A schema's manifest is at most ${manifestMaxBytes} bytes.`
    );
  }
  return manifest;
};

/**
 * A schema's hash: the SHA-256 of its manifest's canonical text, in hex.
 * The manifest names its own format's version, so a new format hashes
 * differently even for the same tables.
 */
export const schemaHash = async (manifest: SchemaManifest): Promise<string> =>
  await sha256Hex(manifestText(manifest));
