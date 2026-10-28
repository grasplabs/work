import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
  ValueDefinitionError,
} from "@grasp-os/sdk";
import type {
  SchemaDefinition,
  ValueDescriptor,
  ValueSchema,
  ValueShape,
} from "@grasp-os/sdk";
import {
  contractFingerprint,
  descriptorVersion,
  managedFields,
  manifestVersion,
  readSchemaManifest,
  schemaHash,
} from "@grasp-os/sdk/host";
import type { OperationManifest, SchemaManifest } from "@grasp-os/sdk/host";
import { serverModule } from "@grasp-os/sdk/server";
import {
  storeOperationPathMaxLength,
  storeOperationPathPattern,
} from "@grasp-os/shared/operation-limits";

import { readOptions } from "./catalog.ts";
import { createChecker } from "./checker.ts";
import type { Checker } from "./checker.ts";
import { compileDataSchema } from "./data-schema.ts";
import { pointerJoin } from "./diagnostics.ts";
import { isObject, parseDefinitionText } from "./json-text.ts";
import type { JsonValue } from "./json-text.ts";
import { profileLimits } from "./limits.ts";
import { allowKeys, at, objectAt, requireKey, workflowSite } from "./values.ts";

// The stores a standalone workflow declares (GRA-682), in
// `document.metadata.grasp.stores`: each a schema of tables and the public
// operations the platform serves on it. Workflows are JSON only (spec
// 13.1), so a store's operations are never code: each is one of four
// generated kinds over one declared table (`get` by ID, `list` by an
// index, `insert`, `patch`), whose arguments and return follow from the
// table. Declaring a store creates nothing: only an admin activating a
// version through the workflow candidate flow does, and the workflow
// becomes its one canonical owner (`sdk_store_owners`, kind `workflow`).
//
// They sit beside the bindings in the Grasp metadata, not in upstream's
// `use`, which is Open Workflow's own (functions, errors, retries and
// timeouts): a store is Grasp's, as a binding is.
//
// Threat model, and how each is closed:
//
// - A schema that passes here but not where a store is made, or the other
//   way round. Tables are compiled through the profile's one JSON Schema
//   translation (data-schema.ts) and then read back as a canonical
//   manifest through the SDK's `readSchemaManifest`, the one path a store's
//   host accepts a schema by: the same checks as an App's `defineSchema`
//   (names, managed fields, indexes, references, sizes), nothing
//   approximated.
// - An operation that reaches past its table, or runs anything. Each is a
//   kind and a table (and, for `list`, an index of that table): nothing
//   scripted, no query text. Its contract (kind, arguments, return) is
//   derived here, the same for every host, and its fingerprint is the
//   SDK's `contractFingerprint` of it, as an App's operations are, so a
//   consumer binds and pins it the way it binds an App's.
// - A later version changing an operation under a consumer. Any change to
//   its table's fields changes its arguments or return and so its
//   fingerprint; a consumer pinned to the old one is refused (slice 4).
// - Records reached around the operations. Every table's own access is
//   `appMembers` both ways, and the only callers a workflow's store ever
//   counts as members are the consumers its generated operations serve
//   (core's store-operations.ts): nobody is a member of a workflow, and no
//   screen or App code reaches its store. So only the generated
//   operations, as the consumer's principal, reach its records, every
//   record of their table, whoever owns it.
// - Diagnostics that repeat the definition. Refusals carry their code and
//   pointer only, never a name or message the SDK built from the text.

const site = workflowSite;

/** The generated operation kinds. */
export const storeOperationKinds = ["get", "list", "insert", "patch"] as const;

export type StoreOperationKind = (typeof storeOperationKinds)[number];

/** A store's name, as its declaration's key: what the candidate flow names. */
const storeNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const storeNameMaxLength = 63;

/** One generated operation, as declared and as a consumer binds it. */
export interface DeclaredStoreOperation {
  readonly kind: StoreOperationKind;
  readonly table: string;
  /** The index a `list` reads by; null to list in creation order. */
  readonly index: string | null;
  /** Its contract, as an App's release has an operation's. */
  readonly manifest: OperationManifest;
}

/** A store a workflow declares, checked. */
export interface DeclaredStore {
  /** Its schema's canonical manifest: what its host is handed. */
  readonly manifest: SchemaManifest;
  /** Its public operations, by path. */
  readonly operations: ReadonlyMap<string, DeclaredStoreOperation>;
}

/** A declared store with the hashes a version seals. */
export interface SealedStore extends DeclaredStore {
  /** The SHA-256 of its manifest's canonical text (`schemaHash`). */
  readonly schemaHash: string;
  /** Each operation's contract fingerprint, by path. */
  readonly fingerprints: Readonly<Record<string, string>>;
}

const isOperationKind = (value: unknown): value is StoreOperationKind =>
  storeOperationKinds.some((kind) => kind === value);

/** The verbs each kind uses on its table: only what it needs. */
const verbsOf = (kind: StoreOperationKind) => ({
  read: kind === "get" || kind === "list" || kind === "patch",
  insert: kind === "insert",
  update: kind === "patch",
  delete: false,
});

/**
 * One table's fields as the SDK declares them, compiled from its JSON
 * Schema (an object), or undefined after reporting why not.
 */
const tableFields = (
  checker: Checker,
  document: JsonValue | undefined,
  pointer: string
): Readonly<Record<string, ValueDescriptor>> | undefined => {
  const compiled = compileDataSchema(document, pointer);
  if (!compiled.ok) {
    for (const problem of compiled.problems) {
      checker.report.error(
        problem.code,
        at(site, problem.pointer),
        problem.remedy,
        {
          ...(problem.expected === undefined
            ? {}
            : { expected: problem.expected }),
          ...(problem.reason === undefined ? {} : { reason: problem.reason }),
        }
      );
    }
    return undefined;
  }
  const { descriptor } = compiled.schema;
  if (descriptor.kind !== "object" || descriptor.nullable) {
    checker.report.error(
      "schema.invalid",
      at(site, pointer),
      "Declare a table as an object schema of its fields, not nullable.",
      { expected: "object" }
    );
    return undefined;
  }
  return descriptor.fields;
};

/** One table's indexes, as a manifest has them, or undefined. */
const tableIndexes = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string
): Record<string, { fields: JsonValue[] }> | undefined => {
  if (value === undefined) {
    return {};
  }
  const indexes = objectAt(checker, value, pointer, site, "indexes");
  if (indexes === undefined) {
    return undefined;
  }
  const read: Record<string, { fields: JsonValue[] }> = {};
  for (const [name, fields] of Object.entries(indexes)) {
    if (!Array.isArray(fields)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, pointerJoin(pointer, name)),
        "List an index's fields, in order.",
        { expected: "array of field names" }
      );
      return undefined;
    }
    read[name] = { fields };
  }
  return read;
};

/** The manifest's tables, from the declaration's, or undefined. */
const manifestTables = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string
): Record<string, unknown> | undefined => {
  const tables = objectAt(checker, value, pointer, site, "tables");
  if (tables === undefined) {
    return undefined;
  }
  let ok = true;
  const read: Record<string, unknown> = {};
  for (const [name, table] of Object.entries(tables)) {
    const tablePointer = pointerJoin(pointer, name);
    const declared = objectAt(checker, table, tablePointer, site, "table");
    if (declared === undefined) {
      ok = false;
      continue;
    }
    allowKeys(checker, declared, ["schema", "indexes"], tablePointer, site);
    if (!requireKey(checker, declared, "schema", tablePointer, site)) {
      ok = false;
      continue;
    }
    const fields = tableFields(
      checker,
      declared.schema,
      pointerJoin(tablePointer, "schema")
    );
    const indexes = tableIndexes(
      checker,
      declared.indexes,
      pointerJoin(tablePointer, "indexes")
    );
    if (fields === undefined || indexes === undefined) {
      ok = false;
      continue;
    }
    read[name] = {
      fields,
      indexes,
      access: { read: "appMembers", write: "appMembers" },
    };
  }
  return ok ? read : undefined;
};

/**
 * The schema `tables` declare, read back through the SDK as a store's
 * host reads one, or undefined after reporting it at `pointer`.
 */
const readTables = (
  checker: Checker,
  tables: Record<string, unknown>,
  pointer: string
): { schema: SchemaDefinition; manifest: SchemaManifest } | undefined => {
  try {
    return readSchemaManifest(
      JSON.stringify({
        manifestVersion,
        descriptorVersion,
        managedFields,
        tables,
      })
    );
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    // The SDK's message names the definition's own tables and fields.
    const code = "code" in error ? String(error.code) : "schema.invalid";
    checker.report.error(
      "schema.invalid",
      at(site, pointer),
      "Fix the tables: names are identifiers, not starting with `_`, indexes name scalar fields of their table, and every ID names a declared table.",
      { reason: code }
    );
    return undefined;
  }
};

/** The fields of `table` in `schema`, as schemas. */
const fieldsOf = (schema: SchemaDefinition, table: string): ValueShape =>
  Object.hasOwn(schema.tables, table)
    ? (schema.tables[table]?.fields ?? {})
    : {};

/** The index `name` of `table` in `manifest`, if it has one. */
const indexOf = (
  manifest: SchemaManifest,
  table: string,
  name: string
): readonly string[] | undefined => {
  const indexes = manifest.tables[table]?.indexes ?? {};
  return Object.hasOwn(indexes, name) ? indexes[name]?.fields : undefined;
};

/**
 * The contract of a generated operation: its arguments and return follow
 * from its kind and table alone.
 *
 * - `get`: `{ id }`, the record or null.
 * - `list`: the page contract of spec 9.2 (`pageSize`, `cursor`), with
 *   `where`, the index's fields to match, when it reads by an index; a
 *   page of records.
 * - `insert`: the table's fields; the new record's ID.
 * - `patch`: `{ id, set }`, `set` any of its fields; null.
 */
const contractOf = (
  path: string,
  schema: SchemaDefinition,
  operation: { kind: StoreOperationKind; table: string; index: string[] | null }
): OperationManifest => {
  const { kind, table, index } = operation;
  const fields = fieldsOf(schema, table);
  // A whole record: its managed fields and its declared ones.
  const record = serverModule(schema).doc(table);
  let args: ValueSchema<unknown, unknown>;
  let returns: ValueSchema<unknown, unknown>;
  if (kind === "get") {
    args = v.object({ id: v.id(table) });
    returns = record.nullable();
  } else if (kind === "list") {
    // An index may end on a managed commit time, which is a timestamp.
    args =
      index === null
        ? paginationOptionsValidator
        : paginationOptionsValidator.extend({
            where: v.object(
              Object.fromEntries(
                index.map((field) => [field, fields[field] ?? v.timestamp()])
              )
            ),
          });
    returns = paginationResultValidator(record);
  } else if (kind === "insert") {
    args = v.object(fields);
    returns = v.id(table);
  } else {
    args = v.object({ id: v.id(table), set: v.object(fields).partial() });
    returns = v.null();
  }
  return Object.freeze({
    path,
    kind: kind === "get" || kind === "list" ? "query" : "mutation",
    visibility: "public",
    args: args.descriptor,
    returns: returns.descriptor,
    stream: null,
    uses: [],
    tables: Object.freeze(
      Object.fromEntries(
        Object.keys(schema.tables).map((name) => [
          name,
          name === table
            ? verbsOf(kind)
            : { read: false, insert: false, update: false, delete: false },
        ])
      )
    ),
  });
};

/**
 * The generated contract `build` makes, or undefined after reporting at
 * the operation why the SDK refused it: a table within the limits may
 * still be too deep once an operation wraps it (a list's page, a patch's
 * `set`), and the SDK refuses a schema past its own (`definition.too_large`).
 */
const generatedContract = (
  checker: Checker,
  pointer: string,
  build: () => OperationManifest
): OperationManifest | undefined => {
  try {
    return build();
  } catch (error) {
    if (!(error instanceof ValueDefinitionError)) {
      throw error;
    }
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "This operation's arguments or answer would nest too deep or declare too much for its table: nest the table's fields less.",
      { expected: "a table this operation can wrap" }
    );
    return undefined;
  }
};

/** One operation's declaration, checked against the store's schema. */
const checkOperation = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  read: { schema: SchemaDefinition; manifest: SchemaManifest }
):
  | { kind: StoreOperationKind; table: string; index: string | null }
  | undefined => {
  const declared = objectAt(checker, value, pointer, site, "operation");
  if (declared === undefined) {
    return undefined;
  }
  allowKeys(checker, declared, ["kind", "table", "index"], pointer, site);
  if (
    !(
      requireKey(checker, declared, "kind", pointer, site) &&
      requireKey(checker, declared, "table", pointer, site)
    )
  ) {
    return undefined;
  }
  const { kind, table } = declared;
  if (!isOperationKind(kind)) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(pointer, "kind")),
      "Choose get, list, insert or patch.",
      { expected: storeOperationKinds.join(", ") }
    );
    return undefined;
  }
  if (
    typeof table !== "string" ||
    !Object.hasOwn(read.manifest.tables, table)
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(pointer, "table")),
      "Name a table the store declares.",
      { expected: "a declared table" }
    );
    return undefined;
  }
  if (!Object.hasOwn(declared, "index")) {
    return { kind, table, index: null };
  }
  const { index } = declared;
  if (
    kind !== "list" ||
    typeof index !== "string" ||
    indexOf(read.manifest, table, index) === undefined
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(pointer, "index")),
      kind === "list"
        ? "Name an index of the operation's table."
        : "Only a list reads by an index: leave index off.",
      { expected: kind === "list" ? "a declared index" : "no index" }
    );
    return undefined;
  }
  return { kind, table, index };
};

/** One store's declaration, checked, or undefined after reporting why. */
const checkStore = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string
): DeclaredStore | undefined => {
  const declared = objectAt(checker, value, pointer, site, "store");
  if (declared === undefined) {
    return undefined;
  }
  allowKeys(checker, declared, ["tables", "operations"], pointer, site);
  if (
    !(
      requireKey(checker, declared, "tables", pointer, site) &&
      requireKey(checker, declared, "operations", pointer, site)
    )
  ) {
    return undefined;
  }
  const tablesPointer = pointerJoin(pointer, "tables");
  const tables = manifestTables(checker, declared.tables, tablesPointer);
  const read =
    tables === undefined
      ? undefined
      : readTables(checker, tables, tablesPointer);
  const operationsPointer = pointerJoin(pointer, "operations");
  const operations = objectAt(
    checker,
    declared.operations,
    operationsPointer,
    site,
    "operations"
  );
  if (read === undefined || operations === undefined) {
    return undefined;
  }
  const paths = Object.entries(operations);
  if (paths.length === 0 || paths.length > profileLimits.maxStoreOperations) {
    checker.report.error(
      "profile.too_many",
      at(site, operationsPointer),
      `Declare 1 to ${profileLimits.maxStoreOperations} operations.`
    );
    return undefined;
  }
  const checked = new Map<string, DeclaredStoreOperation>();
  for (const [path, operation] of paths) {
    const operationPointer = pointerJoin(operationsPointer, path);
    if (
      path.length > storeOperationPathMaxLength ||
      !storeOperationPathPattern.test(path)
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, operationPointer),
        "Name an operation as a permission names it: identifiers joined by dots, at most four.",
        { expected: "operation path" }
      );
      continue;
    }
    const found = checkOperation(checker, operation, operationPointer, read);
    if (found !== undefined) {
      const index =
        found.index === null
          ? null
          : [...(indexOf(read.manifest, found.table, found.index) ?? [])];
      const manifest = generatedContract(checker, operationPointer, () =>
        contractOf(path, read.schema, { ...found, index })
      );
      if (manifest !== undefined) {
        checked.set(path, Object.freeze({ ...found, manifest }));
      }
    }
  }
  if (checked.size !== paths.length) {
    return undefined;
  }
  return Object.freeze({ manifest: read.manifest, operations: checked });
};

/**
 * Checks `document.metadata.grasp.stores`, recording each store the
 * definition declares on `checker.stores`.
 */
export const checkStores = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string
): void => {
  const stores = objectAt(checker, value, pointer, site, "stores");
  if (stores === undefined) {
    return;
  }
  const entries = Object.entries(stores);
  if (entries.length > profileLimits.maxStores) {
    checker.report.error(
      "profile.too_many",
      at(site, pointer),
      `Declare at most ${profileLimits.maxStores} stores.`
    );
    return;
  }
  for (const [name, store] of entries) {
    const storePointer = pointerJoin(pointer, name);
    if (name.length > storeNameMaxLength || !storeNamePattern.test(name)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, storePointer),
        "Name a store in kebab-case, at most 63 characters.",
        { expected: "store name" }
      );
      continue;
    }
    const declared = checkStore(checker, store, storePointer);
    if (declared !== undefined) {
      checker.stores.set(name, declared);
    }
  }
};

/** `store` with its schema hash and each operation's fingerprint. */
export const sealStore = async (store: DeclaredStore): Promise<SealedStore> => {
  const fingerprints: Record<string, string> = {};
  for (const [path, { manifest }] of store.operations) {
    // One after another: a digest is quick, and the order is the map's.
    // oxlint-disable-next-line no-await-in-loop -- see above
    fingerprints[path] = await contractFingerprint(manifest);
  }
  return Object.freeze({
    ...store,
    schemaHash: await schemaHash(store.manifest),
    fingerprints: Object.freeze(fingerprints),
  });
};

/** The value at `path` of `root`, own members only, or undefined. */
const memberAt = (
  root: JsonValue,
  path: readonly string[]
): JsonValue | undefined => {
  let value: JsonValue | undefined = root;
  for (const key of path) {
    if (value === undefined || !isObject(value) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
};

const storesPath = ["document", "metadata", "grasp", "stores"] as const;

/**
 * The stores a published definition declares, read again from its sealed
 * text by the same checks validation ran (`checkStores`), each with its
 * schema hash and fingerprints: what a host serves a workflow store's
 * operations from, and compares with what the version bound. Throws for
 * text that doesn't declare its stores validly, which a sealed version's
 * never is unless it was changed.
 */
export const declaredStoresOf = async (
  definition: string
): Promise<ReadonlyMap<string, SealedStore>> => {
  const parsed = parseDefinitionText(definition, {
    maxBytes: profileLimits.maxDefinitionBytes,
    maxDepth: profileLimits.maxDefinitionDepth,
    maxValues: profileLimits.maxDefinitionValues,
  });
  if (!parsed.ok) {
    throw new Error("The definition isn't valid JSON text");
  }
  const value = memberAt(parsed.value, storesPath);
  const checker = createChecker(readOptions({}));
  if (value !== undefined) {
    checkStores(checker, value, `/${storesPath.join("/")}`);
  }
  if (checker.report.errors() > 0) {
    throw new Error("The definition doesn't declare its stores validly");
  }
  const sealed = new Map<string, SealedStore>();
  for (const [name, store] of checker.stores) {
    // oxlint-disable-next-line no-await-in-loop -- a few digests, in order
    sealed.set(name, await sealStore(store));
  }
  return sealed;
};
