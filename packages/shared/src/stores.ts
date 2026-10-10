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
 * host's own bound on one store transaction, the size spec 18.1 gives a
 * workflow step's input and result. A public operation's own input limit
 * is checked where operations are called, not here.
 */
export const commitMaxInputBytes = 1024 * 1024;

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

/** A SHA-256, in hex. */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * What a mutation's receipt is scoped to, besides its store and key: the
 * person it is for, the resource and binding it came through, the pinned
 * operation contract and the kind of operation. The same key under any
 * other scope is another receipt, so a key never reaches another
 * caller's or operation's outcome.
 */
export const receiptScopeSchema = z.strictObject({
  principal: identifierSchema,
  resource: identifierSchema,
  binding: identifierSchema.nullable(),
  contractId: identifierSchema,
  contractVersion: z.number().int().min(1),
  operationKind: z.literal("mutation"),
});
export type ReceiptScope = z.infer<typeof receiptScopeSchema>;

/**
 * A receipt's key, as core makes it from the caller's idempotency key
 * (`submissionKey`): its parts, such as a workflow step's key and the
 * caller's key under it.
 */
const receiptKeySchema = z.array(identifierSchema).min(1).max(4);

/**
 * An attempt's claim of a mutation's receipt, made before its handler
 * runs: what it is scoped to, its key, the hash of its normalized input,
 * the workflow run it is made in (whose life keeps the receipt) and when
 * its call must end, in milliseconds since the epoch.
 */
export const claimSchema = z.strictObject({
  storeId: storeIdSchema,
  scope: receiptScopeSchema,
  key: receiptKeySchema,
  inputHash: sha256Schema,
  runId: identifierSchema.nullable(),
  deadline: z.number().int().min(0),
});
export type ClaimInput = z.infer<typeof claimSchema>;

/** The attempt holding a receipt, as its commit names it. */
export interface Held {
  receiptId: string;
  fence: number;
  deadline: number;
}

/**
 * What a claim answers: the attempt now holds the receipt, or its
 * mutation committed already, and this was its outcome.
 */
export type Claimed = { held: Held } | { outcome: Committed };

/**
 * The most intents one commit may stage for its outbox: workflow
 * notifications and starts, each handed over after the commit.
 */
export const commitMaxIntents = 16;

/**
 * A workflow notification or start a commit stages: its content is
 * defined where it is delivered.
 */
export const storeIntentKinds = ["workflow.notify", "workflow.start"] as const;

export const storeIntentSchema = z.strictObject({
  kind: z.enum(storeIntentKinds),
  data: fieldValueSchema,
});

/**
 * One commit: the writes a mutation staged and the revisions it read, for
 * whom (`principal`, who owns what it inserts), under which schema, by
 * the attempt holding its receipt (`receipt`), with what it stages for
 * its outbox (`intents`). All of it commits, its receipt's outcome and
 * outbox entries included, or none of it.
 */
export const commitSchema = z
  .strictObject({
    storeId: storeIdSchema,
    principal: z.strictObject({ userId: identifierSchema }),
    schemaHash: schemaHashSchema,
    receipt: z.strictObject({
      receiptId: sha256Schema,
      fence: z.number().int().min(1),
      deadline: z.number().int().min(0),
    }),
    guards: z.array(revisionGuardSchema).max(commitMaxGuards).default([]),
    writes: z.array(storeWriteSchema).max(commitMaxWrites),
    intents: z.array(storeIntentSchema).max(commitMaxIntents).default([]),
  })
  .refine(
    ({ guards, writes, intents }) =>
      encoder.encode(JSON.stringify({ guards, writes, intents })).byteLength <=
      commitMaxInputBytes,
    {
      message: `At most ${commitMaxInputBytes} bytes of writes, guards and intents`,
    }
  );
export type Commit = z.input<typeof commitSchema>;

/**
 * What a commit made: the IDs of the records it inserted, in order, and
 * its place in the store's order of commits.
 */
export interface Committed {
  inserted: string[];
  commit: number;
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
