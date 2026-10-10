import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { identifierSchema, storeIdSchema } from "./ids.ts";
import type { Json } from "./json.ts";

// Business stores: a deployment's structured records, each store one
// Durable Object with its own SQLite database (apps/core/src/data-store.ts),
// independent of the Apps and workflows that use it. A store holds logical
// tables; a table holds records, each one JSON document of the fields its
// schema declares plus the managed fields only the host sets. These are
// the shapes core hands a store: never App code, which reaches records
// only through the operations of its pinned schema.

/**
 * A table or field name: an ASCII letter, then letters, digits or
 * underscores. A field can't start with `_`, which keeps the managed
 * fields (`_id`, `_ownerId`, `_rev`, `_createdAt`, `_updatedAt`) apart
 * from authored ones.
 */
const storeNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/u;

/** The longest table or field name. */
const storeNameMaxLength = 64;

/** A logical table's name, as the schema's map key gives it. */
export const tableNameSchema = z
  .string()
  .max(storeNameMaxLength)
  .regex(storeNamePattern, "A letter, then letters, digits or underscores");

/** A field of a record's document, never a managed one. */
const fieldNameSchema = tableNameSchema;

/**
 * The most bytes of one record's fields, as UTF-8 JSON, as stored: the
 * document limit of spec 18.1. A patch is checked against the document it
 * leaves, not only its own fields. Larger content belongs in files,
 * referenced from a record.
 */
export const documentMaxBytes = 128 * 1024;

/**
 * The most bytes of one commit's writes and guards, as UTF-8 JSON: the
 * limit on a public operation's input (spec 18.1), which a commit carries
 * no more of.
 */
export const commitMaxInputBytes = 128 * 1024;

/** How deeply a record's JSON may nest. */
export const documentMaxDepth = 32;

// The counts below bound what one commit or store holds: a commit is one
// synchronous transaction in one store, and holds the store while it
// runs, so larger changes are a workflow's, in batches. They are the
// host's own until the runtime policy module (validated quotas) sets
// them per deployment.

/** The most tables a store may define. */
export const storeMaxTables = 64;

/** The most writes one commit may stage. */
export const commitMaxWrites = 100;

/** The most revision guards (records read) one commit may carry. */
export const commitMaxGuards = 100;

/** The most fields one patch may unset. */
export const patchMaxUnset = 64;

/** A record's ID: minted by the store, opaque to everyone else. */
export const recordIdSchema = identifierSchema;

/** A record's revision: 1 when inserted, one more for each change. */
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** The SHA-256 of the schema a commit was checked against, in hex. */
const schemaHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * Whether `value` is JSON a store keeps, at most `documentMaxDepth` deep
 * from `depth`: null, strings, booleans, finite numbers, dense arrays and
 * plain objects of those.
 */
const isJsonValue = (value: unknown, depth: number): value is Json => {
  if (depth > documentMaxDepth) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    // A hole is no JSON value: refused rather than read as null.
    return (
      Object.keys(value).length === value.length &&
      value.every((item) => isJsonValue(item, depth + 1))
    );
  }
  const prototype: unknown = Reflect.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((item) => isJsonValue(item, depth + 1))
  );
};

/** One field's value: JSON, as `isJsonValue` has it. */
const fieldValueSchema = z.custom<Json>((value) => isJsonValue(value, 1), {
  message:
    "Only JSON: strings, finite numbers, booleans, null, arrays and plain objects",
});

const encoder = new TextEncoder();

/**
 * A record's fields: a plain JSON object whose keys are field names (never
 * a managed field) and whose values are JSON, at most `documentMaxBytes`.
 * A field set to `undefined` is refused, not dropped.
 */
const fieldsSchema = z
  .record(fieldNameSchema, fieldValueSchema)
  .refine(
    (fields) =>
      encoder.encode(JSON.stringify(fields)).byteLength <= documentMaxBytes,
    { message: `At most ${documentMaxBytes} bytes` }
  );
export type StoreFields = Record<string, Json>;

/** Fields a store already holds, read back from its own JSON. */
export const storedFieldsSchema = z.record(z.string(), fieldValueSchema);

/** A record a commit's outcome depends on, still at the revision it read. */
const revisionGuardSchema = z.strictObject({
  table: tableNameSchema,
  id: recordIdSchema,
  expectedRevision: revisionSchema,
});

/** One write a commit stages: an insert, a patch, a replacement or a delete. */
const storeWriteSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("insert"),
    table: tableNameSchema,
    fields: fieldsSchema,
  }),
  z
    .strictObject({
      op: z.literal("patch"),
      table: tableNameSchema,
      id: recordIdSchema,
      fields: fieldsSchema,
      /** Optional fields to remove; never one the patch also sets. */
      unset: z.array(fieldNameSchema).max(patchMaxUnset).optional(),
      expectedRevision: revisionSchema,
    })
    .refine(
      ({ fields, unset = [] }) =>
        new Set(unset).size === unset.length &&
        unset.every((name) => !Object.hasOwn(fields, name)),
      { message: "unset must name each field once, and none the patch sets" }
    ),
  z.strictObject({
    op: z.literal("replace"),
    table: tableNameSchema,
    id: recordIdSchema,
    fields: fieldsSchema,
    expectedRevision: revisionSchema,
  }),
  z.strictObject({
    op: z.literal("delete"),
    table: tableNameSchema,
    id: recordIdSchema,
    expectedRevision: revisionSchema,
  }),
]);

/**
 * One commit: the writes a mutation staged and the revisions it read, for
 * whom (`principal`, who owns what it inserts) and under which schema.
 * All of it commits, or none of it.
 */
export const commitSchema = z
  .strictObject({
    storeId: storeIdSchema,
    principal: z.strictObject({ userId: identifierSchema }),
    schemaHash: schemaHashSchema,
    guards: z.array(revisionGuardSchema).max(commitMaxGuards).default([]),
    writes: z.array(storeWriteSchema).max(commitMaxWrites),
  })
  .refine(
    ({ guards, writes }) =>
      encoder.encode(JSON.stringify({ guards, writes })).byteLength <=
      commitMaxInputBytes,
    { message: `At most ${commitMaxInputBytes} bytes of writes and guards` }
  );
export type Commit = z.input<typeof commitSchema>;

/** What a commit made: the IDs of the records it inserted, in order. */
export interface Committed {
  inserted: string[];
}

/** One record, as the store holds it: its managed fields and its document. */
export interface StoredRecord {
  id: string;
  ownerId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  schemaHash: string;
  /** Its JSON fields; typed loosely, as RPC types can't carry `Json` deeply. */
  fields: Record<string, unknown>;
}

export const dataErrors = defineErrorFamily({
  "data.invalid": "That change isn't valid for this store.",
  "data.unknown_table": "This store has no such table.",
  "data.table_conflict":
    "Two tables can't have names that differ only in case.",
  "data.too_many_tables": `A store holds at most ${storeMaxTables} tables.`,
  "data.conflict":
    "The record changed since it was read. Read it again, then retry.",
  "data.store_unavailable": "This store doesn't exist or was deleted.",
});
