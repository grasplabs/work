import { storeNamePattern } from "@grasp-os/shared/store-limits";

import { hasExactly, isOverBytes, refuser } from "./declaration.ts";
import { defineSchema } from "./define-schema.ts";
import { defineTable } from "./define-table.ts";
import { SchemaDefinitionError } from "./schema-error.ts";
import type { SchemaDefinitionCode } from "./schema-error.ts";
import { managedFields, schemaLimits } from "./schema-limits.ts";
import {
  manifestMaxBytes,
  manifestVersion,
  mapOf,
  schemaManifest,
} from "./schema-manifest.ts";
import type { SchemaManifest } from "./schema-manifest.ts";
import type { AnyTable, SchemaDefinition } from "./schema-types.ts";
import { descriptorVersion, isPlainObject } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

const refuse: (code: SchemaDefinitionCode, message: string) => never = refuser(
  SchemaDefinitionError
);

/**
 * A name a manifest gave, as a message may quote it: only once it is a
 * valid name, so a refusal never repeats an unbounded piece of what was
 * submitted.
 */
const quoted = (name: string, what: string): string =>
  name.length <= schemaLimits.nameLength && storeNamePattern.test(name)
    ? `${what} \`${name}\``
    : `${what} with an invalid name`;

const invalid = (message: string): never =>
  refuse("schema.invalid_manifest", message);

/** A table being declared from a manifest, whose index fields are data. */
interface ReadTable extends AnyTable {
  readonly index: (name: string, fields: readonly unknown[]) => ReadTable;
  readonly searchIndex: (fields: readonly unknown[]) => ReadTable;
  readonly sensitive: () => ReadTable;
  readonly access: (access: unknown) => ReadTable;
}

// SAFETY: `defineTable` and a table's `index` check at run time all that
// their types check: a manifest's names and index fields are only known
// then.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const declareTable = defineTable as (
  fields: Readonly<Record<string, AnySchema>>
) => ReadTable;

/**
 * Whether a manifest's table has exactly its keys: `fields`, `indexes` and
 * `access`, a `searchIndex` and `rules` if it has them, and
 * `sensitive: true` if declared.
 */
const isTableShaped = (input: unknown): input is Record<string, unknown> => {
  const searched = isPlainObject(input) && Object.hasOwn(input, "searchIndex");
  const declaresSensitive =
    isPlainObject(input) && Object.hasOwn(input, "sensitive");
  return (
    hasExactly(input, [
      "fields",
      "indexes",
      ...(searched ? ["searchIndex"] : []),
      "access",
      ...(declaresSensitive ? ["sensitive"] : []),
      ...(isPlainObject(input) && Object.hasOwn(input, "rules")
        ? ["rules"]
        : []),
    ]) &&
    (!declaresSensitive || input.sensitive === true)
  );
};

/** One table of a manifest of unknown origin, declared again from it. */
const readTable = (name: string, input: unknown): AnyTable => {
  const ruled = isPlainObject(input) && Object.hasOwn(input, "rules");
  if (!isTableShaped(input)) {
    return invalid(
      `${quoted(name, "Table")} is \`{ fields, indexes, searchIndex?, access, rules? }\`, and \`sensitive: true\` if declared, and nothing else.`
    );
  }
  const { fields, indexes, searchIndex, access, rules } = input;
  if (!(isPlainObject(fields) && isPlainObject(indexes))) {
    return invalid(`${quoted(name, "Table")}'s fields and indexes are maps.`);
  }
  // Counted before any is read.
  if (Object.keys(indexes).length > schemaLimits.indexesPerTable) {
    return refuse(
      "schema.too_large",
      `A table has at most ${schemaLimits.indexesPerTable} indexes.`
    );
  }
  // One budget for the whole table, as its document is sealed as one.
  const budget = { nodes: 0 };
  const shape = mapOf<AnySchema>(
    Object.entries(fields).map(([field, descriptor]) => [
      field,
      schemaOf(readDescriptor(descriptor, 1, budget)),
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
      return invalid(
        `${quoted(index, "Index")} is \`{ fields }\`, a short list.`
      );
    }
    table = table.index(index, definition.fields);
  }
  if (Object.hasOwn(input, "searchIndex")) {
    if (
      !(
        hasExactly(searchIndex, ["fields"]) &&
        Array.isArray(searchIndex.fields) &&
        searchIndex.fields.length <= schemaLimits.fieldsPerSearchIndex
      )
    ) {
      return invalid(
        `${quoted(name, "Table")}'s search index is \`{ fields }\`, a short list.`
      );
    }
    table = table.searchIndex(searchIndex.fields);
  }
  if (!hasExactly(access, ["read", "write"])) {
    return invalid(`${quoted(name, "Table")}'s access is \`{ read, write }\`.`);
  }
  // Declared as an author would: `.access` checks the modes and the rules.
  table = table.access({ ...access, ...(ruled ? { rows: rules } : {}) });
  return input.sensitive === true ? table.sensitive() : table;
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
  if (isOverBytes(text, manifestMaxBytes)) {
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
  const schema = defineSchema(
    mapOf(
      Object.entries(tables).map(([name, table]) => [
        name,
        readTable(name, table),
      ])
    )
  );
  return { schema, manifest: schemaManifest(schema) };
};
