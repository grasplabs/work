import { z } from "zod";

import { fileLimits } from "./app-file-limits.ts";
import { defineErrorFamily } from "./errors.ts";
import { appIdSchema, identifierSchema, storeIdSchema } from "./ids.ts";
import type { Json } from "./json.ts";
import { platformLimits } from "./platform-limits.ts";
import {
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

// The counts below bound what one commit or store holds: a commit is one
// synchronous transaction in one store, and holds the store while it
// runs, so larger changes are a workflow's, in batches. They are the
// host's own until the runtime policy module (validated quotas) sets
// them per deployment.

/** The most writes one commit may stage. */
export const commitMaxWrites = 100;

/**
 * The most records one commit's deletions may delete by cascade (records
 * whose `v.id` field says `onDelete: "cascade"`), across every level:
 * more is a workflow's, deleting them in batches first.
 */
export const commitMaxCascade = 100;

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
 * A look at a mutation's receipt, never a claim of it (spec 10.7.8): what
 * it is scoped to and its key, as `claimSchema` has them. Nothing about it
 * changes, and nothing runs.
 */
export const receiptLookupSchema = z.strictObject({
  storeId: storeIdSchema,
  scope: receiptScopeSchema,
  key: receiptKeySchema,
});
export type ReceiptLookup = z.infer<typeof receiptLookupSchema>;

/**
 * Where a mutation's receipt stands, without its outcome: `committed` once
 * its change committed; `claimed` while an attempt holds it, until
 * `deadline`, past which nothing more commits under that attempt;
 * `expired` once only its tombstone is left, so whether it committed
 * can't be told; `none` when no attempt ever claimed it.
 */
export type ReceiptStanding =
  | { readonly state: "committed" }
  | {
      readonly state: "claimed";
      readonly deadline: number;
      /** The latest attempt's claim: each claim moves it on. */
      readonly fence: number;
    }
  | { readonly state: "expired" }
  | { readonly state: "none" };

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
 * Whether the person a commit or a read is for is a member or a builder
 * of the App it comes through, as core resolved it for the invocation:
 * what `appMembers` and `appBuilders` tables require.
 */
export const writerRolesSchema = z.strictObject({
  appMember: z.boolean(),
  appBuilder: z.boolean(),
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
    intents: z.array(storeIntentSchema).max(commitMaxIntents).default([]),
    result: fieldValueSchema.default(null),
    /**
     * The consumer whose call of a store's public operation this commit
     * is (another App or a workflow, by ID and version): kept with the
     * commit for as long as the store is. None for its own App's commits.
     */
    writer: z
      .strictObject({
        resourceId: identifierSchema,
        resourceVersion: z.number().int().min(1),
      })
      .optional(),
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
});
export type Committed = z.infer<typeof committedSchema>;

/**
 * Whom a store applies a schema for: one version of a resource (an App's
 * sealed release), named in the receipt the store keeps of it.
 */
export const schemaConsumerSchema = z.strictObject({
  resourceId: identifierSchema,
  resourceVersion: z.number().int().min(1),
});
export type SchemaConsumer = z.infer<typeof schemaConsumerSchema>;

/**
 * What handing a store a schema did to its data contract: the contract's
 * hash after it, the hash of the plan that moved it, whether it changed,
 * and the receipt the store keeps of it for its consumer (null when none
 * was named). Applying the same schema again answers the first receipt.
 */
export interface AppliedContract {
  /**
   * The contract's hash after the change: for a receipt answered again,
   * the one its first application left, so it always matches `planHash`.
   */
  hash: string;
  planHash: string;
  changed: boolean;
  receiptId: string | null;
  /**
   * Whether the contract `hash` names is still pending: its defaulted
   * fields are being filled in (`StoreHost.fillMissing`), and the store's
   * contract in force is the one before it until that finishes.
   */
  pending: boolean;
}

/**
 * What a store answers when handed a schema: the schema's hash, which its
 * host computed from the manifest itself, the ID of each of the schema's
 * tables by name, and of every table the store holds, the schema's among
 * them (tables are never removed, so a store may hold others), and what
 * it did to the store's contract.
 */
export interface DefinedTables {
  schemaHash: string;
  tables: Record<string, string>;
  storeTables: Record<string, string>;
  contract: AppliedContract;
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

/** Whom a store is shared with, to manage it: a person or a team. */
export const storeMemberSchema = z.strictObject({
  type: z.enum(["person", "team"]),
  id: identifierSchema,
});

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
  "data.cascade_limit": `Deleting this would also delete more than ${commitMaxCascade} records that refer to it, more than one change may. Delete those from a workflow, in batches, first.`,
  "data.store_bound":
    "This store can't be deleted while an App's kept versions read and write it.",
  "data.store_managed_by_app":
    "This store is an App's default store: the App's builders and the organization's admins manage it. Share the App instead.",
  "data.store_closing":
    "This store is already being deleted. Try again in a moment.",
  "data.store_in_use":
    "This store can't be deleted while a mutation's receipt still refers to it. Try again once its receipts have expired.",
});

/**
 * Why a store refused a schema it was handed (spec 17): the change needs
 * a migration (`details.changes` lists each change and why); the store's
 * record of its contract disagrees with its own recorded schemas, or
 * can't be rebuilt from them, which blocks every schema change until
 * repaired, since guessing could lose data; or other schemas kept
 * changing the contract meanwhile (retryable). And why a schema the store
 * took isn't in force yet: its defaulted fields are still being filled in
 * (`migration.pending`, retryable, with the backfill's progress), or the
 * fill found a record whose value doesn't fit the field
 * (`migration.backfill_failed`, naming the record and the target and run
 * an admin abandons it as); a backfill's step from a run the store moved
 * past is `migration.superseded`. Once an admin abandoned a failed
 * target, the releases sealed on it are `migration.abandoned`; only a
 * failed one can be (`migration.not_failed`). A release whose schema an
 * explicit migration left behind can't be made current again (a rollback,
 * spec 17.4): `migration.rollback_incompatible`, its details naming the
 * App's retained versions on the same store that still fit
 * (`details.compatible`, newest first).
 */
/**
 * The most of an App's retained releases a refused rollback looks at for
 * versions that still fit its store (`migration.rollback_incompatible`):
 * its newest.
 */
export const compatibleVersionsMax = 100;

export const migrationErrors = defineErrorFamily({
  "migration.required":
    "This schema change can't be applied on its own: it needs a migration. Add only new tables, optional or defaulted fields and indexes, or keep the fields as they were.",
  "migration.preference_changed":
    "This version changes a preference people may already have chosen. Keep each preference as it was (only its default may change), or add a new preference under a new name.",
  "migration.metadata_missing":
    "This store's schema contract is missing and can't be rebuilt from the schemas it recorded, so no schema change can be applied until it is repaired.",
  "migration.busy":
    "This store kept changing while the schema was applied. Try again in a moment.",
  "migration.metadata_corrupt":
    "This store's record of its schema contract is damaged, so no schema change can be applied until it is repaired.",
  "migration.pending":
    "This store is still filling in the defaults of a schema change. Try again once it has finished.",
  "migration.backfill_failed":
    "This store couldn't fill in a schema change's defaults: a record already holds a value the new field doesn't accept, so the change needs a migration.",
  "migration.superseded":
    "This backfill step belongs to a run the store has moved past.",
  "migration.not_failed":
    "Only a failed schema change can be abandoned: this one's defaults are still being filled in.",
  "migration.abandoned":
    "An admin abandoned this schema change after its defaults couldn't be filled in, so a release sealed on it can't run on this store. Seal a new version.",
  "migration.sample_busy":
    "Another dry run of this migration is running, or it ran a few times in the last minute already. Try again in a minute.",
  "migration.not_pending":
    "This version's migration isn't the change pending on its store, so there is nothing of it to dry-run yet.",
  "migration.not_declared":
    "This version declares no such explicit migration, or binds no store for it to run on.",
  "migration.invalid":
    "This version's migrations don't fit this store: each transforms one table, from a schema the store recorded, to this version's schema, and a migration can't share a change with defaults to fill in elsewhere.",
  "migration.incompatible_write":
    "This version's schema no longer fits the store: a migration moved its records on. Make the migrated version current.",
  "migration.rollback_incompatible":
    "This version's schema no longer fits its store: a migration moved its records on, so it can't be made current again. Make one of the compatible versions current instead.",
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
 * Why a store's backfill failed (`StoresApi.backfill`): a record whose
 * value doesn't fit a field it fills in, or runs that couldn't move on.
 */
export type StoreBackfillFailure =
  | {
      table: string;
      field: string;
      id: string;
      reason: "invalid_value" | "too_large";
    }
  | MigrationFailure
  | { reason: "stalled" }
  | { reason: "ready" };

/**
 * Why an explicit migration's batch failed (spec 17.2): the record, when
 * one is to blame, and what was wrong with it. `issues` (what the
 * transform threw, or why its output was refused) may carry content of
 * other records of the batch, so only the migration's App's builders and
 * admins are shown it.
 */
export interface MigrationFailure {
  table: string;
  id: string | null;
  migration: string;
  reason:
    | "invalid_input"
    | "threw"
    | "invalid_output"
    | "too_large"
    | "invalid_answer"
    | "outside_contract"
    | "reference_changed"
    | "fixtures_failed";
  issues: string[];
}

/** The explicit migration a schema is applied with, for one table. */
export const storeMigrationSchema = z.strictObject({
  name: z.string().min(1).max(64),
  table: z.string().min(1).max(64),
  fromSchema: z.string().regex(/^[0-9a-f]{64}$/u),
  toSchema: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type StoreMigration = z.input<typeof storeMigrationSchema>;

/**
 * A store's pending schema change and its backfill, as an admin sees it:
 * the target, the run it is at, how far it got, and why it failed.
 */
export interface StoreBackfill {
  target: string;
  state: "running" | "failed";
  attempt: number;
  scanned: number;
  filled: number;
  failure: StoreBackfillFailure | null;
  /**
   * An explicit migration that finished: it takes over as a release that
   * needs it is made current, and an admin may still abandon it.
   */
  ready: boolean;
}

/**
 * A store an App uses, and its pending schema change
 * (`StoresApi.appBackfills`).
 */
export interface AppStoreBackfill {
  store: string;
  /**
   * What the App calls the store: the alias of its newest binding; null
   * for its default store when no version it runs or reviews binds it.
   */
  alias: string | null;
  backfill: StoreBackfill;
}

/**
 * An admin's abandonment of a store's failed backfill: the target, as
 * of the run they saw fail (`StoreBackfill.attempt`).
 */
export const abandonBackfillSchema = z.strictObject({
  store: storeIdSchema,
  target: z.string().regex(/^[0-9a-f]{64}$/u),
  attempt: z.number().int().min(1),
});
export type AbandonBackfill = z.input<typeof abandonBackfillSchema>;

/**
 * What abandoning a failed backfill did: the releases sealed on the
 * target, which now never run on the store, and the fields it reserved,
 * which a later schema may add again only as they were.
 */
export interface AbandonedBackfill {
  store: string;
  target: string;
  attempt: number;
  scanned: number;
  filled: number;
  failure: StoreBackfillFailure;
  releases: { app: string; version: number }[];
  reserved: { table: string; field: string }[];
  abandonedAt: string;
}

/** Records a migration's dry run samples by default, and at most. */
export const migrationSampleRows = 20;
export const migrationSampleMaxRows = 100;

/**
 * An admin's request to dry-run an App version's explicit migration on a
 * sample of the real records it would transform (`StoresApi.sampleMigration`).
 */
export const sampleMigrationSchema = z.strictObject({
  app: appIdSchema,
  version: z.number().int().min(1),
  migration: z.string().min(1).max(128),
  rows: z.number().int().min(1).max(migrationSampleMaxRows).optional(),
});
export type SampleMigration = z.input<typeof sampleMigrationSchema>;

/**
 * What a migration's dry run found: `passed` when its transform answered
 * every sampled record with what the target table takes, `failed` when it
 * didn't, `empty` when it had no record left to transform (done, or
 * not started). `failure` names the record and the transform's issues: for the
 * admin who asked alone, kept nowhere (the receipt keeps the reason). On a
 * table read or written by owner, the issues only when the admin owns that
 * record (a thrown message can carry its values): empty otherwise.
 */
export interface MigrationSample {
  id: string;
  app: string;
  version: number;
  migration: string;
  store: string;
  outcome: "passed" | "failed" | "empty";
  rows: number;
  owners: number;
  sampledAt: string;
  failure: { record: string | null; reason: string; issues: string[] } | null;
}

/**
 * Business stores, for admins: a store's failed schema change, and
 * abandoning it (spec 17.2, 17.3), and dry-running an explicit migration on a
 * sample of real records. Abandoning keeps the store's contract
 * as it was and takes the releases sealed on the change out of force, so
 * the store takes schema changes again. Never Grasp staff.
 */
export interface StoresApi {
  /** The store's pending schema change and its backfill; null for none. */
  backfill: (store: string) => Promise<StoreBackfill | null>;
  /**
   * The pending schema changes of the stores an App runs on: those its
   * current and pending versions are bound to, newest first, then its
   * default store. Stores without one aren't listed.
   */
  appBackfills: (app: string) => Promise<AppStoreBackfill[]>;
  /** Abandons the store's failed backfill (see `AbandonedBackfill`). */
  abandonBackfill: (input: AbandonBackfill) => Promise<AbandonedBackfill>;
  /** Dry-runs a version's explicit migration on a sample of real records. */
  sampleMigration: (input: SampleMigration) => Promise<MigrationSample>;
}
