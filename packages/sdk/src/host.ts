import { ValueDefinitionError } from "./value-descriptor.ts";
import type { ValueSchema } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";

// What a host needs of the SDK and App code never does. A host holds
// descriptors as data (in a manifest, from a browser, from another version)
// and turns them back into schemas here, without running the code that
// declared them.

// What a host knows of schemas that App code needn't: the managed fields,
// the limits, and the error a declaration throws.
export {
  allowsNull,
  indexBase,
  managedFields,
  SchemaDefinitionError,
  schemaLimits,
} from "./schema.ts";
export type { IndexBase, SchemaDefinitionCode } from "./schema.ts";

// An App as the host runs it: its registration as data, and its handlers.
export { inspectApp } from "./app.ts";
export type {
  AppInspection,
  AppManifest,
  OperationManifest,
  UseManifest,
} from "./app.ts";
export { appErrorDetailsOf } from "./app-error.ts";

// A schema as a store's host reads, hashes and compares it.
export { diffSchemaManifests, schemaReferences } from "./schema-diff.ts";
export type {
  AccessChange,
  FieldChange,
  IndexChange,
  ReferenceStep,
  SchemaChange,
  SchemaDiff,
  SchemaReference,
  TableChange,
} from "./schema-diff.ts";
export {
  manifestMaxBytes,
  manifestText,
  manifestVersion,
  readSchemaManifest,
  schemaHash,
  schemaManifest,
} from "./schema-manifest.ts";
export type {
  AccessMode,
  ManifestAccess,
  ManifestIndex,
  ManifestTable,
  ReadManifest,
  SchemaAccess,
  SchemaManifest,
  TableAccess,
} from "./schema-manifest.ts";

// Which currencies and time zones this SDK accepts: a host compares it with
// its own before it activates an App.
export { valueCatalogVersion } from "./value-catalog.ts";

// Typed where it is declared: only then does a call narrow what follows it.
const refuse: (message: string) => never = (message) => {
  throw new ValueDefinitionError("definition.invalid_descriptor", message);
};

/**
 * The schema a descriptor describes, read from its JSON text, e.g. as a
 * manifest stores it or a browser sent it.
 *
 * It takes the text, not an object, on purpose: what `JSON.parse` returns is
 * plain data, so nothing the sender wrote runs while it is read (no getters,
 * no proxies), it can't contain itself, and reading it costs in proportion to
 * the text, which is its caller's to bound as it bounds any message.
 *
 * The descriptor is untrusted and is checked as strictly as a declaration in
 * code: text that isn't JSON, unknown versions, kinds and keys, invalid
 * bounds and defaults, prototype keys and oversized descriptors all throw
 * `ValueDefinitionError`.
 */
export const schemaFromDescriptor = (
  text: string
): ValueSchema<unknown, unknown> => {
  if (typeof text !== "string") {
    return refuse("A descriptor is read from its JSON text.");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // What the parser said quotes the text; the refusal doesn't.
    return refuse("The descriptor isn't JSON.");
  }
  return schemaOf(readDescriptor(data, 1, { nodes: 0 }));
};
