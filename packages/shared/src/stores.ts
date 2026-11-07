import { z } from "zod";

import { fileLimits } from "./app-file-limits.ts";
import { auditActorSchema } from "./audit.ts";
import { defineErrorFamily } from "./errors.ts";
import { identifierSchema, storeIdSchema } from "./ids.ts";
import type { Json } from "./json.ts";
import { platformLimits } from "./platform-limits.ts";
import {
  queryMaxGroups,
  queryMaxResults,
  queryMaxScannedBytes,
  queryMaxScannedEntries,
  storeMaxIndexes,
  storeMaxTables,
  storeNameMaxLength,
  storeNamePattern,
} from "./store-limits.ts";
import { valueDepth } from "./value-depth.ts";

// Business stores: a deployment's structured records, each store one
// Durable Object with its own SQLite database (apps/core/src/data-store.ts),
// independent of the Apps and workflows that use it. A store holds logical
// tables; a table holds records, each one JSON document of the fields its
// schema declares plus the managed fields only the host sets. These are
// the shapes core hands a store: never App code, which reaches records
// only through the operations of its pinned schema.

/** A logical table's name, as the schema's map key gives it. */
export const tableNameSchema = z
  .string()
  .max(storeNameMaxLength)
  .regex(storeNamePattern, "A letter, then letters, digits or underscores");

/** A field of a record's document, never a managed one. */
const fieldNameSchema = tableNameSchema;

/**
 * The most bytes of one record's fields, as UTF-8 JSON, as stored: the
 * persisted row limit of spec 18.1. A patch is checked against the
 * document it leaves, not only its own fields, and so are the defaults a
 * migration or backfill fills in. Larger content belongs in files,
 * referenced from a record.
 */
export const documentMaxBytes = platformLimits.persistedRowBytes;

/**
 * The most bytes of one commit's writes, guards and intents, as UTF-8 JSON: the
 * host's own bound on one store transaction, the size spec 18.1 gives a
 * workflow step's input and result. A public operation's own input limit
 * is checked where operations are called, not here.
 */
export const commitMaxInputBytes = platformLimits.stepPayloadBytes;

/**
 * The most bytes of writes one mutation may stage, as UTF-8 JSON: what is
 * left of a commit's bound after its result (at most a public operation's
 * output, `operationResultMaxBytes`) and its guards and read set (at most
 * 100 and 64, well within 64 KiB), so a mutation that stages within it
 * always fits its commit. The operation host refuses the write that
 * passes it.
 */
export const stagedMaxBytes =
  commitMaxInputBytes - platformLimits.operationOutputBytes - 64 * 1024;

/**
 * How deeply a record's JSON may nest: a field's value gets `valueDepth`
 * levels, counted from the field (its value is level 1, its leaf
 * included), as deep as any value may be.
 */
export const documentMaxDepth = valueDepth;

/**
 * How deep an argument App code in a sandboxed isolate sends core may be
 * (the operation channel, its forwarders, a test's or an action's host):
 * a write's request (`WriteRequest`) around its fields around a field as
 * deep as a record keeps, the deepest shape any of them takes. Deeper
 * than a page's (`rpcArgumentDepth`, which nothing on a page needs past
 * `valueDepth`), so a write a store keeps is never refused on its way.
 */
export const isolateArgumentDepth = documentMaxDepth + 2;

// The counts below bound what one commit or store holds: a commit is one
// synchronous transaction in one store, and holds the store while it
// runs, so larger changes are a workflow's, in batches. They are the
// host's own until the runtime policy module (validated quotas) sets
// them per deployment.

/** The most writes one commit may stage. */
export const commitMaxWrites = 100;

/**
 * The most records one commit's deletions delete by cascade (records whose
 * `v.id` field says `onDelete: "cascade"`), across every level, in the
 * commit itself. More, up to `cascadeJobMaxRecords`, the store deletes in
 * batches of this many after the commit, as a cascade job (store-host.ts).
 */
export const commitMaxCascade = 100;

/**
 * The most records one deletion's cascade may reach in all, the deleted
 * records included: past it, the deletion is refused.
 */
export const cascadeJobMaxRecords = 10_000;

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
    /**
     * The new record's ID, which core minted when the write was staged
     * (`mintRecordId`), so the mutation could read and return it before
     * its commit: never one App code chose. A record that exists already
     * under it is a conflict.
     */
    id: recordIdSchema,
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

/**
 * The attempt holding a receipt, as its commit names it. The deadline it
 * claimed with stays with the store, which checks it.
 */
export interface Held {
  receiptId: string;
  fence: number;
}

/**
 * What a claim answers: the attempt now holds the receipt, or its
 * mutation committed already, and this was its outcome. `startedAt` is
 * when the receipt was made: the same for every attempt of one
 * submission, and new for a fresh one under the key once it is gone.
 * So is `seed`, the receipt's random seed (64 hex digits), which the
 * mutation's randomness answers from.
 */
export type Claimed =
  | { held: Held; startedAt: number; seed: string }
  | { outcome: Committed; startedAt: number };

/**
 * The most intents one commit may stage for its outbox: workflow
 * notifications and starts, and sends to people, each handed over after
 * the commit.
 */
export const commitMaxIntents = 16;

/**
 * A workflow notification or start a commit stages, or the form a page
 * sent as the mutation, for its App's webhooks: its content is defined
 * where it is delivered.
 */
export const storeIntentKinds = [
  "app.form_sent",
  "app.notify",
  "workflow.notify",
  "workflow.start",
] as const;

export const storeIntentSchema = z.strictObject({
  kind: z.enum(storeIntentKinds),
  data: fieldValueSchema,
});

/**
 * The most teams a commit or a read names for its person: far more than
 * anyone is in, so a bound only against a request that is too large.
 */
export const callerTeamsMax = 1000;

/**
 * The IDs of the teams the person a commit or a read is for is in, as
 * core read them for the invocation, from its own records (never from
 * what App code sends): what a table's `team` row rules match. None for a
 * visitor, and when left out.
 */
export const callerTeamsSchema = z
  .array(identifierSchema)
  .max(callerTeamsMax)
  .optional();

/**
 * Whether the person a commit or a read is for is a member or a builder
 * of the App it comes through, and the teams they are in, as core
 * resolved them for the invocation: what `appMembers` and `appBuilders`
 * tables require, and what row rules match.
 */
export const writerRolesSchema = z.strictObject({
  appMember: z.boolean(),
  appBuilder: z.boolean(),
  teams: callerTeamsSchema,
});
export type WriterRoles = z.infer<typeof writerRolesSchema>;

/**
 * The generation of each table a mutation's reads saw (its read set): a
 * commit is refused (`data.reads_changed`) once any has moved on, so a
 * mutation never commits on reads another commit made stale.
 */
const readSetSchema = z
  .record(tableNameSchema, z.number().int().min(0))
  .refine((readSet) => Object.keys(readSet).length <= storeMaxTables, {
    message: `At most ${storeMaxTables} tables`,
  });

/** The writes a mutation staged, and when: what its reads see before commit. */
export const stagedWritesSchema = z.strictObject({
  /**
   * When core staged them, in milliseconds since the epoch: the time the
   * records they change are stamped with, the same in the reads that see
   * them before the commit as in the commit.
   */
  stagedAt: z.number().int().min(0),
  writes: z.array(storeWriteSchema).max(commitMaxWrites),
});
export type StagedWrites = z.input<typeof stagedWritesSchema>;

/**
 * One commit: the writes a mutation staged (at `stagedAt`) and what it
 * read (its guards and read set), for whom (`principal`, who owns what it
 * inserts, with the `roles` core resolved for them just before), under
 * which schema, whose access the store enforces on every write, by the
 * attempt holding its receipt (`receipt`), with what it returned
 * (`result`, kept for a retry of the same submission) and what it stages
 * for its outbox (`intents`). All of it commits, its receipt's outcome
 * and outbox entries included, or none of it.
 */
export const commitSchema = z
  .strictObject({
    storeId: storeIdSchema,
    principal: z.strictObject({ userId: identifierSchema }),
    /**
     * Who the audit log names as making the commit (the person, an agent
     * acting for them, a visitor, a workflow run or the App), as core
     * resolved it for the invocation: whom the store's change history of
     * each record it writes names.
     */
    actor: auditActorSchema,
    roles: writerRolesSchema,
    schemaHash: schemaHashSchema,
    receipt: z.strictObject({
      receiptId: sha256Schema,
      fence: z.number().int().min(1),
    }),
    stagedAt: z.number().int().min(0),
    guards: z.array(revisionGuardSchema).max(commitMaxGuards).default([]),
    readSet: readSetSchema.default({}),
    writes: z.array(storeWriteSchema).max(commitMaxWrites),
    // What App code stages, and the one form a page's call adds.
    intents: z
      .array(storeIntentSchema)
      .max(commitMaxIntents + 1)
      .default([]),
    result: fieldValueSchema.default(null),
    /**
     * The App's files resources that declare `attach`, as its sealed
     * release says: a record may newly hold only a file uploaded through
     * one of them (core's file-host.ts). None, and it may newly hold none.
     */
    attachable: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u))
      .max(fileLimits.resources)
      .default([]),
  })
  .refine(
    ({ guards, readSet, writes, intents, result }) =>
      encoder.encode(
        JSON.stringify({ guards, readSet, writes, intents, result })
      ).byteLength <= commitMaxInputBytes,
    {
      message: `At most ${commitMaxInputBytes} bytes of writes, guards, intents and result`,
    }
  );
export type Commit = z.input<typeof commitSchema>;

/**
 * What a commit made: the IDs of the records it inserted, in order, its
 * place in the store's order of commits, and what the mutation returned.
 * It crosses RPC as JSON text (RPC types can't carry `Json` deeply), read
 * back with this schema.
 */
export const committedSchema = z.strictObject({
  inserted: z.array(z.string()),
  commit: z.number().int(),
  result: fieldValueSchema,
  /**
   * The records a cascade deleted with the commit's own deletions, each
   * with its table and its owner, kept with the receipt: who deleted them
   * is the commit's principal. Left out when there were none.
   */
  cascaded: z
    .array(
      z.strictObject({ table: z.string(), id: z.string(), owner: z.string() })
    )
    .max(commitMaxCascade)
    .optional(),
  /**
   * A cascade past `commitMaxCascade`: the job deleting its members after
   * the commit, and how many there are, the commit's own deletions
   * included. They stay readable, and refuse writes and new references,
   * until the job deletes them. Left out when there was none.
   */
  cascadePending: z
    .strictObject({
      job: z.string(),
      members: z.int().min(1).max(cascadeJobMaxRecords),
    })
    .optional(),
});
export type Committed = z.infer<typeof committedSchema>;

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
  "data.invalid_schema": "That schema isn't one a store can hold.",
  "data.unknown_table": "This store has no such table.",
  "data.table_conflict":
    "Two tables can't have names that differ only in case.",
  "data.too_many_tables": `A store holds at most ${storeMaxTables} tables.`,
  "data.too_many_indexes": `A store holds at most ${storeMaxIndexes} indexes, those kept for older versions included.`,
  "data.conflict":
    "The record changed since it was read. Read it again, then retry.",
  "data.store_unavailable": "This store doesn't exist or was deleted.",
  "data.fixture_discarded": "This fixture store was discarded.",
  "data.receipt_invalid":
    "This commit doesn't hold a receipt its caller claimed.",
  "data.unknown_schema": "This store wasn't handed that schema.",
  "data.unknown_index": "That table has no such index.",
  "data.access_denied": "You can't read this table.",
  "data.write_denied": "You can't change records of this table.",
  "data.guard_limit": `A mutation asserts the revisions of at most ${commitMaxGuards} records.`,
  "data.reads_changed":
    "The records this change read changed before it committed. Try again.",
  "data.invalid_query": "That query isn't valid for this table.",
  "data.scan_limit": `A query reads at most ${queryMaxScannedEntries} entries and ${queryMaxScannedBytes} bytes. Narrow it with an index range, or page through it.`,
  "data.result_limit": `This query matches more than ${queryMaxResults} records. Page through them instead.`,
  "data.group_limit": `This grouped read has more than ${queryMaxGroups} groups. Narrow it with a filter or an index range, or group by fewer fields.`,
  "data.not_unique": "More than one record matches.",
  "data.incompatible_record":
    "A stored record doesn't fit the schema this read is pinned to.",
  "data.invalid_cursor": "That cursor isn't one for this query.",
  "data.cursor_expired":
    "That cursor no longer applies. Start again from the first page.",
  "data.aggregate_overflow":
    "That aggregate is past the largest number there is.",
  "data.index_required":
    "This query needs an index this store doesn't hold for its schema.",
  "data.referenced":
    "This record can't be deleted while another record refers to it. Remove those references first.",
  "data.reference_invalid":
    "This record refers to a record that doesn't exist or that you can't read.",
  "data.cascade_limit": `Deleting this would also delete more than ${cascadeJobMaxRecords} records that refer to it, more than one deletion may. Delete some of those first, in batches.`,
  "data.deleting":
    "This record is being deleted, with the records that refer to it. It can't be changed or referred to meanwhile.",
  "data.store_bound":
    "This store can't be deleted while an App's kept versions read and write it.",
  "data.store_closing":
    "This store is already being deleted. Try again in a moment.",
  "data.store_in_use":
    "This store can't be deleted while a mutation's receipt still refers to it. Try again once its receipts have expired.",
});

/**
 * Why a store refused a version's schema as it was published (spec 17):
 * the change needs a migration (`details.refused`, each change and why),
 * or records lack a field it requires (`details.lacking`, each with how
 * many); its migration doesn't transform from the schema the store holds,
 * or failed on a record (`details`: the migration, table, record and
 * why); records changed while it ran, or another version's publish
 * applied its schema meanwhile (retryable). And why a call is refused: a
 * version runs on its store only under the schema the store holds, its
 * App's current version's.
 */
export const migrationErrors = defineErrorFamily({
  "migration.required":
    "This schema change can't be published as it is: each change it lists needs a migration in code, and each field records lack needs a value for them (an answer) or a migration.",
  "migration.preference_changed":
    "This version changes a preference people may already have chosen. Keep each preference as it was (only its default may change), or add a new preference under a new name.",
  "migration.metadata_missing":
    "This store holds records but no catalog of its schema, so no schema can be applied to it.",
  "migration.metadata_corrupt":
    "This store's record of its preferences is damaged, so no version can change them until it is repaired.",
  "migration.busy":
    "This store changed while the schema was applied, or another version was being published. Publish again in a moment.",
  "migration.invalid":
    "This version's migrations don't fit its store: each transforms one table from the schema the store holds to this version's.",
  "migration.failed":
    "This version's migration failed on a record, so nothing was published. Fix the migration and publish again.",
  "migration.not_current":
    "This version's schema isn't the one its store holds: a version runs on its store only once it is published.",
});

/**
 * Why a query operation's reads couldn't be answered as one state of the
 * store: retryable, as spec 6.3 says (`details.retryable`).
 */
export const queryErrors = defineErrorFamily({
  "query.concurrent_change":
    "The records changed while they were read. Try again.",
});

/**
 * An App's value for the records that lack one field its schema requires
 * (the SDK's `SchemaAnswer`), filled in as the version is published.
 */
export const schemaAnswerSchema = z.strictObject({
  table: z.string().min(1).max(64),
  field: z.string().min(1).max(64),
  value: z.json(),
});

/** The most answers one schema is applied with. */
export const schemaAnswersMax = 64;
