import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import {
  defineSchema,
  defineTable,
  managedFields,
  SchemaDefinitionError,
  schemaLimits,
  tablesOf,
} from "./schema.ts";
import type {
  AnyTable,
  SchemaDefinition,
  SchemaDefinitionCode,
  TableState,
} from "./schema.ts";
import { descriptorVersion, isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

// A schema's canonical manifest: the one form of a schema that leaves the
// code that declared it. A store's host is handed it, a schema's hash is
// the SHA-256 of its canonical text, and two versions are compared by it.
//
// It holds everything that decides what a record may be and who may reach
// it: each table's field descriptors (defaults and constraints included),
// its indexes, in field order, and its access modes, with the versions of
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

/**
 * Who a table's records reach, for reading or for writing: only their
 * owner, the App's members, its builders, or nobody.
 */
export type AccessMode = "owner" | "appMembers" | "appBuilders" | "none";

const accessModes: ReadonlySet<unknown> = new Set<AccessMode>([
  "owner",
  "appMembers",
  "appBuilders",
  "none",
]);

/** A table's access, as an App declares it: a mode left out is `none`. */
export interface TableAccess {
  readonly read?: AccessMode;
  readonly write?: AccessMode;
}

/**
 * The access an App (or a store) declares for a schema's tables, as
 * `app.access` holds it: a table left out is `none` both ways.
 */
export interface SchemaAccess {
  readonly tables?: Readonly<Record<string, TableAccess>>;
}

/** A table's access as a manifest holds it: both modes, explicit. */
export interface ManifestAccess {
  readonly read: AccessMode;
  readonly write: AccessMode;
}

/** An index as a manifest holds it: its fields, in order. */
export interface ManifestIndex {
  readonly fields: readonly string[];
}

/** A table as a manifest holds it. */
export interface ManifestTable {
  readonly fields: Readonly<Record<string, ValueDescriptor>>;
  readonly indexes: Readonly<Record<string, ManifestIndex>>;
  readonly access: ManifestAccess;
}

/** A schema's canonical manifest. */
export interface SchemaManifest {
  readonly manifestVersion: typeof manifestVersion;
  readonly descriptorVersion: typeof descriptorVersion;
  readonly managedFields: typeof managedFields;
  readonly tables: Readonly<Record<string, ManifestTable>>;
}

// Typed where it is declared: only then does a call narrow what follows it.
const refuse: (code: SchemaDefinitionCode, message: string) => never = (
  code,
  message
) => {
  throw new SchemaDefinitionError(code, message);
};

/** Whether `value` is a plain object with exactly the keys `keys`. */
const hasExactly = (
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> =>
  isPlainObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** A map of names an author or a manifest gave, without prototype keys. */
const mapOf = <Value>(
  entries: Iterable<readonly [string, Value]>
): Record<string, Value> => {
  const map: Record<string, Value> = {};
  for (const [key, value] of entries) {
    // Defined, not assigned: no key can reach the prototype.
    Object.defineProperty(map, key, { enumerable: true, value });
  }
  return map;
};

const isAccessMode = (value: unknown): value is AccessMode =>
  accessModes.has(value);

/** One table's declared access, both modes explicit. */
const tableAccessOf = (table: string, declared: unknown): ManifestAccess => {
  if (declared === undefined) {
    return { read: "none", write: "none" };
  }
  const { read = "none", write = "none" } = isPlainObject(declared)
    ? declared
    : {};
  const known = isPlainObject(declared)
    ? Object.keys(declared).every((key) => key === "read" || key === "write")
    : false;
  if (!(known && isAccessMode(read) && isAccessMode(write))) {
    return refuse(
      "schema.invalid_access",
      `Table \`${table}\`'s access is \`read\` and \`write\`, each \`owner\`, \`appMembers\`, \`appBuilders\` or \`none\`.`
    );
  }
  return { read, write };
};

/** The declared access of each of `tables`, checked against them. */
const accessOf = (
  tables: Readonly<Record<string, TableState>>,
  access: unknown
): Record<string, ManifestAccess> => {
  const declared = isPlainObject(access) ? access.tables : undefined;
  const isShaped =
    isPlainObject(access) &&
    Object.keys(access).every((key) => key === "tables") &&
    (declared === undefined || isPlainObject(declared));
  if (!isShaped) {
    return refuse(
      "schema.invalid_access",
      "Access is `{ tables }`, a map of table names to their access."
    );
  }
  const byTable = isPlainObject(declared) ? declared : {};
  for (const table of Object.keys(byTable)) {
    if (!Object.hasOwn(tables, table)) {
      refuse(
        "schema.unknown_table",
        `Access names table \`${table}\`, which the schema doesn't have.`
      );
    }
  }
  return mapOf(
    Object.keys(tables).map((table) => [
      table,
      tableAccessOf(table, byTable[table]),
    ])
  );
};

/**
 * The canonical manifest of `schema`, made with `defineSchema`, with the
 * access declared for its tables (`app.access`, or a store's own): every
 * table's access explicit, `none` where none was declared. Throws
 * `SchemaDefinitionError` for access that names a table the schema hasn't,
 * or a mode that doesn't exist.
 */
export const schemaManifest = (
  schema: SchemaDefinition,
  access: SchemaAccess = {}
): SchemaManifest => {
  const tables = tablesOf(schema);
  const accesses = accessOf(tables, access);
  return {
    manifestVersion,
    descriptorVersion,
    managedFields,
    tables: mapOf(
      Object.entries(tables).map(([name, table]) => [
        name,
        {
          fields: table.fields,
          indexes: mapOf(
            table.indexes.map((index) => [index.name, { fields: index.fields }])
          ),
          // Every table has its entry: `accessOf` made one for each.
          access: accesses[name] ?? { read: "none", write: "none" },
        },
      ])
    ),
  };
};

/**
 * A manifest's canonical text: the same for the same schema and access,
 * whatever order they were declared in.
 */
export const manifestText = (manifest: SchemaManifest): string => {
  // SAFETY: parsing JSON text always gives a JSON value; and a manifest
  // loses nothing through JSON: it holds names, strings, the versions and
  // sealed descriptors, whose defaults are JSON.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, unicorn/prefer-structured-clone -- see SAFETY; not a clone, a reading as JSON
  const json = JSON.parse(JSON.stringify(manifest)) as Json;
  return canonicalJson(json);
};

/**
 * A schema's hash: the SHA-256 of its manifest's canonical text, in hex.
 * The manifest names its own format's version, so a new format hashes
 * differently even for the same tables.
 */
export const schemaHash = async (manifest: SchemaManifest): Promise<string> =>
  await sha256Hex(manifestText(manifest));

const invalid = (message: string): never =>
  refuse("schema.invalid_manifest", message);

/** A table being declared from a manifest, whose index fields are data. */
interface ReadTable extends AnyTable {
  readonly index: (name: string, fields: readonly unknown[]) => ReadTable;
}

// SAFETY: `defineTable` and a table's `index` check at run time all that
// their types check: a manifest's names and index fields are only known
// then.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const declareTable = defineTable as (
  fields: Readonly<Record<string, AnySchema>>
) => ReadTable;

/** One table of a manifest of unknown origin, declared again from it. */
const readTable = (
  name: string,
  input: unknown
): { table: AnyTable; access: ManifestAccess } => {
  if (!hasExactly(input, ["fields", "indexes", "access"])) {
    return invalid(
      `Table \`${name}\` is \`{ fields, indexes, access }\` and nothing else.`
    );
  }
  const { fields, indexes, access } = input;
  if (!(isPlainObject(fields) && isPlainObject(indexes))) {
    return invalid(`Table \`${name}\`'s fields and indexes are maps.`);
  }
  // Counted before any is read.
  if (Object.keys(indexes).length > schemaLimits.indexesPerTable) {
    return refuse(
      "schema.too_large",
      `A table has at most ${schemaLimits.indexesPerTable} indexes.`
    );
  }
  const shape = mapOf<AnySchema>(
    Object.entries(fields).map(([field, descriptor]) => [
      field,
      schemaOf(readDescriptor(descriptor, 1, { nodes: 0 })),
    ])
  );
  // Declared as an author would, so a manifest passes exactly the checks
  // a declaration does. `defineTable` checks the names.
  let table = declareTable(shape);
  for (const [index, definition] of Object.entries(indexes)) {
    if (
      !(
        hasExactly(definition, ["fields"]) &&
        Array.isArray(definition.fields) &&
        definition.fields.length <= schemaLimits.fieldsPerIndex
      )
    ) {
      return invalid(`Index \`${index}\` is \`{ fields }\`, a short list.`);
    }
    table = table.index(index, definition.fields);
  }
  if (!hasExactly(access, ["read", "write"])) {
    return invalid(`Table \`${name}\`'s access is \`{ read, write }\`.`);
  }
  return { table, access: tableAccessOf(name, access) };
};

/** What a manifest read back declares: its schema, and its manifest. */
export interface ReadManifest {
  readonly schema: SchemaDefinition;
  readonly manifest: SchemaManifest;
}

/**
 * The schema a manifest declares, read from its JSON text as a store's
 * host is handed it, and its manifest made again from it: canonical
 * whatever order the text had its keys in.
 *
 * The text is untrusted. It takes text, not an object, so that what is
 * read is plain data (no getters, no proxies, no cycles), and checks its
 * size before parsing it. Then the manifest is declared again, table by
 * table, through `defineTable` and `defineSchema`: it passes exactly the
 * checks a declaration in code does, and no other path to a schema
 * exists. Unknown versions and keys, prototype keys, invalid names,
 * indexes and references, malformed descriptors and anything too large
 * throw `SchemaDefinitionError` or `ValueDefinitionError`.
 */
export const readSchemaManifest = (text: string): ReadManifest => {
  if (typeof text !== "string") {
    return invalid("A manifest is read from its JSON text.");
  }
  // Each code unit is at most three bytes: a short text needs no encoding.
  if (
    text.length > manifestMaxBytes &&
    new TextEncoder().encode(text).byteLength > manifestMaxBytes
  ) {
    return refuse(
      "schema.too_large",
      `A manifest is at most ${manifestMaxBytes} bytes.`
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // What the parser said quotes the text; the refusal doesn't.
    return invalid("The manifest isn't JSON.");
  }
  if (
    !hasExactly(data, [
      "manifestVersion",
      "descriptorVersion",
      "managedFields",
      "tables",
    ])
  ) {
    return invalid(
      "A manifest is `{ manifestVersion, descriptorVersion, managedFields, tables }` and nothing else."
    );
  }
  if (
    data.manifestVersion !== manifestVersion ||
    data.descriptorVersion !== descriptorVersion
  ) {
    return invalid("The manifest's versions aren't ones this SDK knows.");
  }
  // Parsed JSON, so its text is the comparison.
  if (JSON.stringify(data.managedFields) !== JSON.stringify(managedFields)) {
    return invalid("The manifest's managed fields aren't the host's.");
  }
  const { tables } = data;
  if (!isPlainObject(tables)) {
    return invalid("A manifest's tables are a map.");
  }
  // Counted before any is read.
  if (Object.keys(tables).length > schemaLimits.tables) {
    return refuse(
      "schema.too_large",
      `A schema has at most ${schemaLimits.tables} tables.`
    );
  }
  const read = Object.entries(tables).map(
    ([name, table]) => [name, readTable(name, table)] as const
  );
  const schema = defineSchema(
    mapOf(read.map(([name, { table }]) => [name, table]))
  );
  const manifest = schemaManifest(schema, {
    tables: mapOf(read.map(([name, { access }]) => [name, access])),
  });
  return { schema, manifest };
};
