import { ValueDefinitionError } from "@grasp-os/sdk";
import {
  manifestText,
  planSchemaChange,
  readSchemaManifest,
  SchemaDefinitionError,
  schemaHash as hashOf,
} from "@grasp-os/sdk/host";
import type {
  AcceptedPlan,
  ReadManifest,
  SchemaManifest,
} from "@grasp-os/sdk/host";
import { auditActorSchema } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { storeMaxTables } from "@grasp-os/shared/store-limits";
import {
  readRequestSchema,
  readScopeSchema,
} from "@grasp-os/shared/store-queries";
import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { QueryRequest, ReadRequest } from "@grasp-os/shared/store-reads";
import {
  claimSchema,
  commitSchema,
  committedSchema,
  dataErrors,
  documentMaxBytes,
  migrationErrors,
  recordIdSchema,
  schemaConsumerSchema,
  stagedWritesSchema,
  storeIntentSchema,
  storedFieldsSchema,
  tableNameSchema,
} from "@grasp-os/shared/stores";
import type {
  AppliedContract,
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  DefinedTables,
  SchemaConsumer,
  StagedWrites,
  StoreFields,
  StoredRecord,
  WriterRoles,
} from "@grasp-os/shared/stores";
import {
  submissionErrors,
  submissionRetentionDays,
  submissionTombstoneDays,
} from "@grasp-os/shared/submissions";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  min,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import {
  outbox,
  receipts,
  recordRefs,
  records,
  schemaActivations,
  schemas,
  store,
  tables,
} from "./db/data-store/schema.ts";
import { liveRuns } from "./live-runs.ts";
import {
  assertTimeout,
  backoffMs,
  consumerFor,
  defaultBudgetMs,
  defaultMaxAttempts,
  defaultTimeoutMs,
  handOver,
} from "./outbox-delivery.ts";
import type { DrainOptions, OutboxConsumers } from "./outbox-delivery.ts";
import { cursorKeysOf, openCursor, sealCursor } from "./store-cursors.ts";
import type { CursorBinding, CursorKeys } from "./store-cursors.ts";
import { inventoriedDeleted, recordStoreDeleted } from "./store-deletion.ts";
import type { StoreDeletionMark } from "./store-deletion.ts";
import { installIndexes, planIndexes } from "./store-indexes.ts";
import {
  pagePlans,
  planQuery,
  readableTable,
  readPage,
  readRecord,
  runQuery,
} from "./store-queries.ts";
import type {
  Anchor,
  PageAnswer,
  PinnedSchema,
  QueryAnswer,
  RecordSql,
} from "./store-queries.ts";
import { recordReferences } from "./store-references.ts";

// The host of a business store (data-store.ts is its Durable Object): one
// object per store, named by the store's ID (data-stores.ts), with a SQLite database of its own that holds all
// of the store's logical tables and their records. The layout is the
// host's and fixed (db/data-store/schema.ts): a table is a row with an ID
// the store mints, a record a row with its managed fields in columns and
// its declared fields in one JSON document. No name an author chose ever
// becomes SQL: tables are found by ID, values are bound parameters.
//
// Only core holds this object's stub (`DATA_STORES` is one of core's own
// bindings, which App and workflow code never get), and core reaches it
// only for a store its inventory lists. Each deployment's core has a
// namespace of these objects of its own, so stores of two deployments
// never meet, whatever their names.
//
// A commit is one synchronous transaction: every revision guard and
// write checks against the store as it is, and all of the commit's
// writes land, or none do. Multiple writes to one record in a commit
// change its revision once; a record inserted in the commit is at
// revision 1 until it commits. A commit that changes nothing in a record
// leaves its revision and update time as they were.
//
// Every commit is made under a receipt (`sdk_mutation_receipts`), which
// the attempt claims before its handler runs, and the commit writes its
// outcome and its outbox entries in the same transaction as its records.
// The rules of the Knowledge receipts (knowledge/receipts.ts) carry over;
// one object's transaction is all the fencing they need here. Threat
// model, and how each is closed:
//
// - A stale attempt commits after a newer one began: every claim moves
//   the receipt's fence on, and a commit is refused
//   (`submission.superseded`) unless it holds the current fence, checked
//   in its transaction. Every attempt under a receipt has the same input
//   (other input is refused at the claim), so an attempt that finds its
//   mutation committed by another answers that outcome.
// - A call is killed, or times out, after its handler staged its writes:
//   nothing is written before the commit, and the commit checks the
//   attempt's deadline by this object's clock, in its transaction
//   (`submission.deadline_passed`). A killed attempt's claim only holds
//   the key; the next attempt claims again and commits once.
// - A commit's answer is lost, then retried: the retry's claim finds the
//   outcome and answers it, writing nothing.
// - A key is reused with other input: `submission.key_conflict`; a key
//   whose receipt expired is `submission.expired` while its tombstone is
//   kept.
// - A key crosses callers or operations: a receipt's ID hashes the store,
//   the whole scope (person, resource, binding, contract and its version,
//   operation kind) and the key, and a commit is refused unless its
//   principal is the receipt's.
// - A receipt expires under a commit: every claim keeps it a retention
//   from then, and the commit another from the commit; a receipt whose
//   outbox still owes an entry, or whose run is live, is never expired.
// - An outbox entry is lost or handed over twice: it commits with its
//   records, stays until settled, is leased before each hand-over and
//   settled only by the lease holder, and keeps one ID however often it is
//   handed over: a drain that dies mid-way, or stalls past its lease (a
//   starved isolate, a slow write), leaves the lease to run out, and the
//   entry is handed over again under that ID, while the drain that lost the
//   lease settles nothing. A kind nothing takes can't be staged; one whose
//   consumer is gone fails its attempts like any hand-over, so a rollback
//   doesn't drop it, and is settled as `outbox.no_consumer` once they run
//   out, so it doesn't keep its receipt forever. Every commit gives its
//   entries IDs of their own (its number in the store's order), so a key
//   that commits again after its tombstone went never reuses one.
// - The alarm spins, or stops: it is set only for what it can act on (an
//   owed entry, a receipt the sweep may expire, a tombstone), never
//   sooner than a second away, again after work that failed (a while
//   later), and on every wake-up, so a commit whose object died before
//   setting it is still drained. Its drain and sweep are each bounded in
//   time; the next alarm continues.
// - A schema is crafted to break the host, or to pass for another: the
//   manifest is read as untrusted text (bounded, strict, declared again
//   through the SDK's own checks, sdk/src/schema-manifest.ts), and its
//   hash is computed here from its canonical text, never taken as given.
// - A caller bends time or delivery: the object's RPC methods take no
//   clock, consumers or budget; only tests choose them, through this host
//   inside the object.

/**
 * `read()`, with SQLite's refusal of an index it doesn't hold (one an
 * older layout or a damaged store lacks) as `data.index_required`, never
 * a scan.
 */
const indexRequired = <Answer>(read: () => Answer): Answer => {
  try {
    return read();
  } catch (error) {
    // SQLite's own error, never one of the store's (whose messages may
    // say as much).
    if (
      error instanceof Error &&
      dataErrors.codeOf(error) === undefined &&
      /no such index/u.test(error.message)
    ) {
      // A store whose indexes don't match its schemas needs looking at.
      log.error("store.index_missing", errorFields(error));
      throw dataErrors.create("data.index_required");
    }
    throw error;
  }
};

/**
 * What a read answers: its value, and the generation of the table it
 * read, at the moment it read it (`sdk_tables.generation`).
 */
export interface ReadResult {
  value: QueryAnswer;
  generations: Record<string, number>;
}

/** A store's record, as staged in a commit. */
interface Staged {
  /** Its table's name, for what a refusal says. */
  table: string;
  tableId: string;
  recordId: string;
  /** The row as committed before this commit; none for a record it inserted. */
  base: typeof records.$inferSelect | undefined;
  /** Its fields as staged so far; null once the commit deleted it. */
  fields: StoreFields | null;
}

/** Where a staged record is kept: its table and ID, which can't collide. */
const keyOf = (tableId: string, recordId: string): string =>
  JSON.stringify([tableId, recordId]);

/** A record's fields as stored: canonical, so equal fields store equal text. */
const storedText = (fields: StoreFields): string => canonicalJson(fields);

/** The fields a row stores. Its JSON is an object, as SQLite checks. */
const fieldsOf = (row: { valueJson: string }): StoreFields =>
  storedFieldsSchema.parse(JSON.parse(row.valueJson));

const toStored = (row: typeof records.$inferSelect): StoredRecord => ({
  id: row.recordId,
  ownerId: row.ownerId,
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  schemaHash: row.schemaHash,
  fields: fieldsOf(row),
});

const encoder = new TextEncoder();

const dayMs = 24 * 60 * 60 * 1000;

/** How long a receipt is kept from each claim, and from its commit. */
const retentionMs = submissionRetentionDays * dayMs;

/** How long a tombstone is kept, so a key reused late is refused as expired. */
const tombstoneMs = submissionTombstoneDays * dayMs;

/** How much later a receipt kept for its live run is looked at again. */
const liveRunRecheckMs = dayMs;

/** Most receipts, tombstones or outbox entries one pass reads at a time. */
const page = 100;

/** A committed receipt's outcome, which `commit` wrote from a `Committed`. */
const outcomeOf = (stored: string): Committed =>
  committedSchema.parse(JSON.parse(stored));

/** Whether a receipt's outbox owes no entry, which the sweep requires. */
const nothingOwed = sql`NOT EXISTS (SELECT 1 FROM ${outbox} WHERE ${outbox.receiptId} = ${receipts.receiptId} AND ${outbox.settledAt} IS NULL)`;

/** How long a sweep goes on taking pages, at most, as for Knowledge receipts. */
const sweepBudgetMs = 20_000;

/** Most records a deleted store's purge removes in one transaction. */
const purgePage = 1000;

/** How long one alarm goes on purging before the next one continues. */
const purgeBudgetMs = 10_000;

/**
 * What a deleted store's purge removes, in this order: each table only
 * once nothing refers to its rows (records name tables, entries receipts).
 * Fixed names, never an author's.
 */
const purgedTables = [
  "sdk_record_refs",
  "sdk_records",
  "sdk_schemas",
  "sdk_change_outbox",
  "sdk_mutation_receipts",
  "sdk_tables",
] as const;

/** The least wait before the alarm comes again, so it never spins. */
const alarmGapMs = 1000;

/** The wait before the alarm tries again after its work failed. */
const alarmRetryMs = 30_000;

/** A stored intent, or undefined if it no longer reads as one. */
const intentOf = (stored: string) => {
  let json: unknown = null;
  try {
    json = JSON.parse(stored);
  } catch {
    // Not JSON: unreadable, as below.
  }
  return storeIntentSchema.safeParse(json).data;
};

/** A deleted store's mark, as its row holds it. */
const markOf = (row: {
  deletedAt: number | null;
  deletedBy: string | null;
}): StoreDeletionMark => {
  if (row.deletedAt === null || row.deletedBy === null) {
    throw new Error("A deleted store has no deletion mark");
  }
  return {
    deletedAt: row.deletedAt,
    deletedBy: auditActorSchema.parse(JSON.parse(row.deletedBy)),
  };
};

/**
 * The schema a manifest's text declares, read as an untrusted manifest;
 * `data.invalid_schema`, with the check's code, if it fails one.
 */
const readSchema = (manifest: string): ReadManifest => {
  // What a refusal says goes back to the caller as its issue. Neither error
  // repeats what was submitted: a descriptor's refusals name no value (a
  // default included), and a manifest's quote only names that are valid.
  try {
    // It refuses anything but text itself: what crossed RPC may be other.
    return readSchemaManifest(manifest);
  } catch (error) {
    if (
      error instanceof SchemaDefinitionError ||
      error instanceof ValueDefinitionError
    ) {
      throw dataErrors.create("data.invalid_schema", {
        code: error.code,
        issues: [error.message],
      });
    }
    throw error;
  }
};

/** The most refused changes a `migration.required` lists. */
const refusalsListed = 50;

/** The store's contract as its row holds it, read back and checked. */
interface StoreContract {
  readonly hash: string;
  readonly manifest: SchemaManifest;
}

/**
 * The contract a store's row holds, checked: its text must read as a
 * manifest, be that manifest's canonical text and hash to the hash beside
 * it; otherwise `migration.metadata_corrupt`. Null when the row holds
 * none.
 */
const contractOf = async (row: {
  contractHash: string | null;
  contractManifest: string | null;
}): Promise<StoreContract | null> => {
  const { contractHash: hash, contractManifest: text } = row;
  if (hash === null && text === null) {
    return null;
  }
  if (hash === null || text === null) {
    throw migrationErrors.create("migration.metadata_corrupt");
  }
  let manifest: SchemaManifest;
  try {
    ({ manifest } = readSchemaManifest(text));
  } catch (error) {
    if (
      error instanceof SchemaDefinitionError ||
      error instanceof ValueDefinitionError
    ) {
      throw migrationErrors.create("migration.metadata_corrupt");
    }
    throw error;
  }
  if (manifestText(manifest) !== text || (await sha256Hex(text)) !== hash) {
    throw migrationErrors.create("migration.metadata_corrupt");
  }
  return { hash, manifest };
};

/** What a plan added and kept, as its receipt records it. */
const planRecord = (
  plan: AcceptedPlan,
  identities: { base: string | null; schema: string; contract: string }
): string =>
  canonicalJson({
    ...identities,
    addedTables: [...plan.addedTables],
    addedFields: plan.addedFields.map(({ table, field }) => [table, field]),
    addedIndexes: plan.addedIndexes.map(({ table, index }) => [table, index]),
    retainedTables: [...plan.retainedTables],
    retainedFields: plan.retainedFields.map(({ table, field }) => [
      table,
      field,
    ]),
    retainedIndexes: plan.retainedIndexes.map(({ table, index }) => [
      table,
      index,
    ]),
  });

/** A schema's change of a store's contract, worked out before it applies. */
interface ContractChange {
  /** The contract's hash as the store's row holds it: what the write compares. */
  readonly stored: string | null;
  /** The hash of the contract planned from: the row's, or one rebuilt. */
  readonly base: string | null;
  readonly hash: string;
  readonly text: string;
  readonly changed: boolean;
  readonly planHash: string;
  readonly plan: string;
  readonly consumer: SchemaConsumer | undefined;
  readonly receiptId: string | null;
  /** Applied for its consumer already: answer the receipt, write nothing. */
  readonly replay: boolean;
}

/** The IDs of the schema's tables, and of every table the store holds. */
const definedTables = (
  names: readonly string[],
  all: readonly { name: string; tableId: string }[]
): Pick<DefinedTables, "tables" | "storeTables"> => {
  const schemaTables = new Set(names);
  return {
    tables: Object.fromEntries(
      all
        .filter(({ name }) => schemaTables.has(name))
        .map(({ name, tableId }) => [name, tableId])
    ),
    storeTables: Object.fromEntries(
      all.map(({ name, tableId }) => [name, tableId])
    ),
  };
};

const conflict = (table: string, id: string) =>
  dataErrors.create("data.conflict", { table, id });

/**
 * How far ahead of this object's clock a commit's staging time may be:
 * core's clock and the object's are the platform's, and differ by far
 * less; a time further ahead is refused rather than stamped on records.
 */
const stagedAheadMs = 60_000;

/** One write a commit or a preview applies, as checked. */
type StoredWrite = z.output<typeof stagedWritesSchema>["writes"][number];

/** A preview's staged writes, as checked. */
type Preview = z.output<typeof stagedWritesSchema>;

/** How a deleted store's purge goes, which tests choose. */
export interface PurgeOptions {
  /** Rows per transaction. */
  page?: number;
  /** How long one alarm goes on purging. */
  budgetMs?: number;
}

/** What a sweep depends on, which tests choose. */
export interface SweepOptions {
  /** How long it goes on taking pages; the next alarm continues. */
  budgetMs?: number;
  /** Which runs of those named are live. */
  live?: (runIds: readonly string[]) => Promise<Set<string>>;
}

/**
 * A store's object, as the host's code works on it: the store's
 * operations with what they depend on passed in (who takes outbox
 * entries, the clock, the live-run lookup). The Durable Object
 * (`DataStore`) fixes those to the deployment's registry and the real
 * clock; tests choose them, inside the object. Not a Durable Object
 * itself, so none of this is reachable over RPC.
 */
export class StoreHost {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  readonly #db: DrizzleSqliteDODatabase;
  /** The store's cursor keys, once derived (`#cursorKeys`). */
  #keys: CursorKeys | undefined;
  /** Each schema read so far, by hash (`#pinned`). */
  readonly #schemas = new Map<string, PinnedSchema>();
  /** The store's contract as last read, by its hash (`#contractNow`). */
  #contract: StoreContract | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.#db = drizzle(ctx.storage);
  }

  /**
   * Applies the schema whose manifest is `manifest` (its JSON text) to the
   * store: its tables, its indexes, and the store's data contract, for
   * `consumer` when one is named; answers the schema's hash, every
   * table's ID by name and what it did to the contract. The manifest is
   * untrusted: it is read as `readSchemaManifest` reads it, bounded and
   * strict, and declared again through the SDK's checks, and the hash is
   * computed here, from its canonical text, never taken from the caller.
   * A schema that fails a check is refused (`data.invalid_schema`, with
   * the check's code).
   *
   * The contract (spec 17.4) is every table and field of every schema
   * the store accepted: a schema is applied only when the change it makes
   * to it is safe (`planSchemaChange`: new tables, new optional fields,
   * new or redefined indexes; tables and optional fields left out are
   * kept), and refused otherwise (`migration.required`, listing each
   * change and why), before anything is written. So every record the
   * store holds fits the contract, and every version sealed on it stays
   * compatible, a rollback included. The contract is checked against the
   * store's own recorded schemas on every call: each must fit it
   * unchanged, or it is `migration.metadata_corrupt`, as is one whose text
   * doesn't read, isn't canonical or doesn't hash to its hash. A store
   * whose row holds no contract has it rebuilt from those recorded
   * schemas, folded oldest first as they were accepted; it refuses
   * (`migration.metadata_missing`) only when that fold refuses, or holds
   * records without any recorded schema. Nothing is guessed.
   *
   * Everything lands in one transaction, or nothing does: new tables with
   * the IDs minted for them (a name differing from an existing one only
   * in case is refused, as is one past `storeMaxTables`), a physical
   * index for each declared index the store doesn't hold yet
   * (store-indexes.ts; `data.too_many_indexes` past `storeMaxIndexes`),
   * the manifest under its hash, the contract, compared and set against
   * the one the change was planned from, and the consumer's receipt
   * (`sdk_schema_activations`). That transaction is the store's lease:
   * two schemas applied at once are applied one after the other, each
   * against the contract the other left, and a crash or a failed index
   * leaves the contract as it was. Applying a schema again writes nothing
   * new and answers its first receipt. Nothing is ever renamed, dropped
   * or rewritten here: no record changes.
   */
  async defineTables(
    storeId: StoreId,
    manifest: string,
    consumer?: SchemaConsumer
  ): Promise<DefinedTables> {
    const read = readSchema(manifest);
    const named =
      consumer === undefined
        ? undefined
        : dataErrors.parse("data.invalid", schemaConsumerSchema, consumer);
    const schemaHash = await hashOf(read.manifest);
    const names = Object.keys(read.manifest.tables);
    const text = manifestText(read.manifest);
    // Hashing is asynchronous and a transaction isn't: so the contract is
    // read and the change planned, and the IDs of new tables minted and
    // their indexes planned, from the store as it is; then everything
    // lands in one transaction, which checks first that the tables and
    // the contract are still what they were planned from. Should another
    // call change either in between, it plans again.
    for (let attempt = 1; ; attempt += 1) {
      const before = this.#tableRows();
      // Planned before anything is written.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const change = await this.#planContract(read.manifest, schemaHash, named);
      const known = new Map(before.map(({ name, tableId }) => [name, tableId]));
      const planned = Object.fromEntries(
        names.map((name) => [name, known.get(name) ?? crypto.randomUUID()])
      );
      // Planned table by table; nothing is written yet.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const plan = await planIndexes(read.manifest, planned);
      const defined = this.ctx.storage.transactionSync(() =>
        this.#defineIn(storeId, before, planned, plan, schemaHash, text, change)
      );
      if (defined !== null) {
        return { schemaHash, ...defined };
      }
      if (attempt >= 3) {
        // Lost to other schemas applied at once, each time: refused as
        // retryable, never left to a generic failure.
        throw migrationErrors.create("migration.busy", { retryable: true });
      }
    }
  }

  /**
   * How `target` changes the store's contract (see `defineTables`), from
   * the contract its row holds now; refused when it needs a migration or
   * the contract can't be trusted.
   */
  async #planContract(
    target: SchemaManifest,
    schemaHash: string,
    consumer: SchemaConsumer | undefined
  ): Promise<ContractChange> {
    const row = this.#db
      .select({
        contractHash: store.contractHash,
        contractManifest: store.contractManifest,
        deletedAt: store.deletedAt,
      })
      .from(store)
      .get();
    if (row !== undefined && row.deletedAt !== null) {
      throw dataErrors.create("data.store_unavailable");
    }
    // What the store's tables refuse, refused first with its own code, as
    // the transaction would: a union holding both would only say it needs
    // a migration.
    const held = this.#tableRows();
    const byKey = new Map(held.map(({ name }) => [name.toLowerCase(), name]));
    for (const name of Object.keys(target.tables)) {
      const existing = byKey.get(name.toLowerCase());
      if (existing !== undefined && existing !== name) {
        throw dataErrors.create("data.table_conflict", {
          table: name,
          existing,
        });
      }
    }
    const after = new Set([
      ...held.map(({ name }) => name),
      ...Object.keys(target.tables),
    ]);
    if (after.size > storeMaxTables) {
      throw dataErrors.create("data.too_many_tables");
    }
    const { stored, base } = await this.#currentContract(row);
    // Applied for this consumer already: its receipt is the answer, after
    // the checks above, and nothing is planned or written again, so a
    // retry never moves the contract (nor the indexes it lists) under a
    // receipt that recorded another change.
    const { receiptId, kept } = await this.#receiptOf(consumer, schemaHash);
    if (kept !== undefined) {
      return {
        stored,
        base: base?.hash ?? null,
        hash: stored ?? base?.hash ?? "",
        text: "",
        changed: false,
        planHash: kept.planHash,
        plan: "",
        consumer,
        receiptId,
        replay: true,
      };
    }
    const plan = planSchemaChange(base?.manifest ?? null, target);
    if (!plan.accepted) {
      throw migrationErrors.create("migration.required", {
        changes: plan.refused.slice(0, refusalsListed).map((refusal) => ({
          ...refusal,
        })),
      });
    }
    const contractText = manifestText(plan.contract);
    const hash = await sha256Hex(contractText);
    const record = planRecord(plan, {
      base: base?.hash ?? null,
      schema: schemaHash,
      contract: hash,
    });
    return {
      stored,
      base: base?.hash ?? null,
      hash,
      text: contractText,
      changed: plan.changed,
      planHash: await sha256Hex(record),
      plan: record,
      consumer,
      receiptId,
      replay: false,
    };
  }

  /**
   * The ID of `consumer`'s receipt for the schema `schemaHash` (null when
   * no consumer is named), and the receipt itself if the store keeps one.
   */
  async #receiptOf(
    consumer: SchemaConsumer | undefined,
    schemaHash: string
  ): Promise<{
    receiptId: string | null;
    kept: { planHash: string } | undefined;
  }> {
    if (consumer === undefined) {
      return { receiptId: null, kept: undefined };
    }
    const receiptId = await sha256Hex(
      canonicalJson({
        resourceId: consumer.resourceId,
        resourceVersion: consumer.resourceVersion,
        schemaHash,
      })
    );
    const kept = this.#db
      .select({ planHash: schemaActivations.planHash })
      .from(schemaActivations)
      .where(eq(schemaActivations.receiptId, receiptId))
      .get();
    return { receiptId, kept };
  }

  /**
   * The store's contract (see `defineTables`), checked against what the
   * store itself recorded: every schema it holds must fit the contract,
   * adding no table or field to it, or the contract is `migration.metadata_corrupt`, whatever
   * its hash says. A store whose row holds no contract has it rebuilt from
   * its own recorded schemas, oldest first, each planned onto the ones
   * before it, as they were accepted; nothing is guessed, so a fold that
   * refuses is `migration.metadata_missing`, and so are records without
   * any recorded schema. Null for a store holding nothing.
   */
  async #currentContract(
    row:
      | { contractHash: string | null; contractManifest: string | null }
      | undefined
  ): Promise<{ stored: string | null; base: StoreContract | null }> {
    const recorded = this.#recordedSchemas();
    const kept = row === undefined ? null : await contractOf(row);
    if (kept !== null) {
      for (const manifest of recorded) {
        // Its tables, fields and access all in the contract already; its
        // indexes are physical, installed whatever the contract lists.
        const plan = planSchemaChange(kept.manifest, manifest);
        if (
          !plan.accepted ||
          plan.addedTables.length > 0 ||
          plan.addedFields.length > 0
        ) {
          throw migrationErrors.create("migration.metadata_corrupt");
        }
      }
      return { stored: kept.hash, base: kept };
    }
    if (recorded.length === 0) {
      this.#requireNoRecords();
      return { stored: null, base: null };
    }
    let folded: SchemaManifest | null = null;
    for (const manifest of recorded) {
      const plan = planSchemaChange(folded, manifest);
      if (!plan.accepted) {
        throw migrationErrors.create("migration.metadata_missing");
      }
      folded = plan.contract;
    }
    if (folded === null) {
      throw new Error("A fold of recorded schemas left no contract");
    }
    return {
      stored: null,
      base: { hash: await sha256Hex(manifestText(folded)), manifest: folded },
    };
  }

  /**
   * Every schema the store recorded, oldest first (ties by hash), read
   * back; one that doesn't read is `migration.metadata_corrupt`.
   */
  #recordedSchemas(): SchemaManifest[] {
    return this.#db
      .select({ manifest: schemas.manifest })
      .from(schemas)
      .orderBy(asc(schemas.createdAt), asc(schemas.schemaHash))
      .all()
      .map(({ manifest }) => {
        try {
          return readSchemaManifest(manifest).manifest;
        } catch (error) {
          if (
            error instanceof SchemaDefinitionError ||
            error instanceof ValueDefinitionError
          ) {
            throw migrationErrors.create("migration.metadata_corrupt");
          }
          throw error;
        }
      });
  }

  /**
   * Refuses (`migration.metadata_missing`) records in a store that
   * recorded no schema: there is nothing to rebuild their contract from.
   */
  #requireNoRecords(): void {
    const held = this.#db
      .select({ id: records.recordId })
      .from(records)
      .limit(1)
      .get();
    if (held !== undefined) {
      throw migrationErrors.create("migration.metadata_missing");
    }
  }

  /**
   * `defineTables`' one transaction: the schema's new tables with the IDs
   * its indexes were planned for, the indexes, the schema, the contract
   * and the consumer's receipt; null, with nothing written, if the tables
   * or the contract changed since they were read.
   */
  #defineIn(
    storeId: StoreId,
    before: readonly { name: string; tableId: string }[],
    planned: Readonly<Record<string, string>>,
    plan: Awaited<ReturnType<typeof planIndexes>>,
    schemaHash: string,
    text: string,
    change: ContractChange
  ): Omit<DefinedTables, "schemaHash"> | null {
    const names = Object.keys(planned);
    this.#bind(storeId);
    if (canonicalJson(this.#tableRows()) !== canonicalJson(before)) {
      return null;
    }
    const current = this.#db
      .select({ contractHash: store.contractHash })
      .from(store)
      .get();
    if ((current?.contractHash ?? null) !== change.stored) {
      return null;
    }
    if (change.base === null) {
      // Planned from nothing: still nothing, or plan again.
      if (this.#recordedSchemas().length > 0) {
        return null;
      }
      this.#requireNoRecords();
    }
    const now = Date.now();
    for (const name of names) {
      const existing = this.#db
        .select({ name: tables.name })
        .from(tables)
        .where(eq(tables.nameKey, name.toLowerCase()))
        .get();
      if (existing !== undefined) {
        if (existing.name !== name) {
          throw dataErrors.create("data.table_conflict", {
            table: name,
            existing: existing.name,
          });
        }
        continue;
      }
      this.#db
        .insert(tables)
        .values({
          tableId: planned[name] ?? crypto.randomUUID(),
          name,
          nameKey: name.toLowerCase(),
          createdAt: now,
        })
        .run();
    }
    const all = this.#tableRows();
    if (all.length > storeMaxTables) {
      throw dataErrors.create("data.too_many_tables");
    }
    if (change.replay) {
      return {
        ...definedTables(names, all),
        contract: this.#receive(schemaHash, change, now),
      };
    }
    installIndexes(this.ctx.storage.sql, plan);
    this.#db
      .insert(schemas)
      .values({ schemaHash, manifest: text, createdAt: now })
      .onConflictDoNothing()
      .run();
    if (change.hash !== change.stored) {
      this.#db
        .update(store)
        .set({ contractHash: change.hash, contractManifest: change.text })
        .run();
    }
    return {
      ...definedTables(names, all),
      contract: this.#receive(schemaHash, change, now),
    };
  }

  /**
   * The consumer's receipt of the change (see `defineTables`): written
   * now if it has none for this schema, otherwise the one it has, whose
   * plan is the one that applied the schema first.
   */
  #receive(
    schemaHash: string,
    change: ContractChange,
    now: number
  ): AppliedContract {
    const { consumer, receiptId } = change;
    const applied: AppliedContract = {
      hash: change.hash,
      planHash: change.planHash,
      changed: change.changed,
      receiptId,
    };
    if (consumer === undefined || receiptId === null) {
      return applied;
    }
    const kept = this.#db
      .select({
        planHash: schemaActivations.planHash,
        contractHash: schemaActivations.contractHash,
        baseHash: schemaActivations.baseHash,
      })
      .from(schemaActivations)
      .where(eq(schemaActivations.receiptId, receiptId))
      .get();
    if (kept !== undefined) {
      // The receipt's own: what its first application left, so its hash
      // and plan always describe the same change.
      return {
        hash: kept.contractHash,
        planHash: kept.planHash,
        changed: kept.contractHash !== kept.baseHash,
        receiptId,
      };
    }
    this.#db
      .insert(schemaActivations)
      .values({
        receiptId,
        resourceId: consumer.resourceId,
        resourceVersion: consumer.resourceVersion,
        schemaHash,
        baseHash: change.base,
        contractHash: change.hash,
        planHash: change.planHash,
        plan: change.plan,
        createdAt: now,
      })
      .run();
    return applied;
  }

  /** The store's tables, by name and ID, in a stable order. */
  #tableRows(): { name: string; tableId: string }[] {
    return this.#db
      .select({ name: tables.name, tableId: tables.tableId })
      .from(tables)
      .orderBy(asc(tables.tableId))
      .all();
  }

  /** The record `id` of `table`, or null if the store has none. */
  get(storeId: StoreId, table: string, id: string): StoredRecord | null {
    const name = dataErrors.parse("data.invalid", tableNameSchema, table);
    const recordId = dataErrors.parse("data.invalid", recordIdSchema, id);
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      const row = this.#db
        .select()
        .from(records)
        .where(
          and(
            eq(records.tableId, this.#tableId(name)),
            eq(records.recordId, recordId)
          )
        )
        .get();
      return row === undefined ? null : toStored(row);
    });
  }

  /**
   * Answers one read for `scope`, which core resolved for the invocation:
   * a record by ID, or a query (store-queries.ts, whose threat model this
   * follows), checked against the schema `scope` is pinned to as this
   * store recorded it. The request is untrusted and checked whole.
   */
  async read(
    storeId: StoreId,
    scope: ReadScope,
    request: ReadRequest,
    staged?: StagedWrites
  ): Promise<ReadResult> {
    const reader = dataErrors.parse("data.invalid", readScopeSchema, scope);
    const read = dataErrors.parse(
      "data.invalid_query",
      readRequestSchema,
      request
    );
    const preview =
      staged === undefined
        ? undefined
        : dataErrors.parse("data.invalid", stagedWritesSchema, staged);
    const pinned = await this.#pinned(storeId, reader.schemaHash);
    if (read.kind === "query" && read.query.terminal.kind === "paginate") {
      return await this.#page(storeId, reader, pinned, read.query, preview);
    }
    const table = read.kind === "get" ? read.table : read.query.table;
    return this.#readIn(storeId, pinned, reader, table, preview, (statements) =>
      indexRequired(() =>
        read.kind === "get"
          ? readRecord(statements, pinned, reader, read)
          : runQuery(statements, pinned, reader, read.query)
      )
    );
  }

  /**
   * Runs `read` (of `table`) in one transaction, with the generation of
   * `table` taken first: what the read depended on, which a reader
   * compares later (store-reader.ts), handed back with its answer and
   * added to a data error it fails with (`details.generations`), since a
   * read that failed after it looked at records (`data.not_unique`,
   * `data.result_limit`, ...) depended on them as much as one that
   * answered.
   *
   * With `preview` (a mutation's writes, staged and not yet committed),
   * the writes are applied first, as its commit would apply them (the
   * same checks, owner, metadata and staging time), the read sees them,
   * and the transaction is then rolled back: nothing is kept, and the
   * generation handed back is the one from before them.
   */
  #readIn<Answer>(
    storeId: StoreId,
    pinned: PinnedSchema,
    reader: ReadScope,
    table: string,
    preview: Preview | undefined,
    read: (statements: RecordSql) => Answer
  ): { value: Answer; generations: Record<string, number> } {
    const run = () => {
      this.#bind(storeId, false);
      const generations = this.#generationsOf(pinned, [table]);
      let readRecords = false;
      try {
        if (preview !== undefined) {
          const { staged } = this.#apply(
            pinned,
            reader.principal,
            reader,
            preview.writes,
            []
          );
          this.#flush(
            staged,
            reader.principal,
            reader.schemaHash,
            preview.stagedAt
          );
        }
        // The read's own statements, counted: only once SQLite took one
        // has the read looked at records (a refusal before any, such as
        // `data.access_denied`, depended on none, and carries no
        // generations, so its reader isn't rerun for every commit).
        const storage = this.ctx.storage.sql;
        const counted: RecordSql = {
          exec: <Row extends Record<string, SqlStorageValue>>(
            query: string,
            ...bindings: unknown[]
          ): SqlStorageCursor<Row> => {
            const cursor = storage.exec<Row>(query, ...bindings);
            readRecords = true;
            return cursor;
          },
        };
        return { value: read(counted), generations };
      } catch (error) {
        if (
          readRecords &&
          error instanceof Error &&
          dataErrors.codeOf(error) !== undefined
        ) {
          const details: unknown = Reflect.get(error, "details");
          Reflect.set(error, "details", {
            ...(typeof details === "object" && details !== null ? details : {}),
            generations,
          });
        }
        throw error;
      }
    };
    if (preview === undefined) {
      return this.ctx.storage.transactionSync(run);
    }
    let answer:
      | { value: Answer; generations: Record<string, number> }
      | undefined;
    // Thrown to end the transaction, so SQLite rolls back everything it
    // did; told apart from any other failure by identity.
    const rollback = new Error("Rolled back after a preview");
    try {
      this.ctx.storage.transactionSync(() => {
        answer = run();
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) {
        throw error;
      }
    }
    if (answer === undefined) {
      throw new Error("A preview's transaction ended without an answer");
    }
    return answer;
  }

  /**
   * The current generation of each of `names` (tables of this store):
   * what a reader compares its read set with when its reads are done.
   * A table the store doesn't hold is left out, which no read set matches.
   */
  generations(
    storeId: StoreId,
    names: readonly string[]
  ): Record<string, number> {
    const parsed = dataErrors.parse(
      "data.invalid",
      z.array(tableNameSchema).max(storeMaxTables),
      names
    );
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      const rows = this.#db
        .select({ name: tables.name, generation: tables.generation })
        .from(tables)
        .where(inArray(tables.name, parsed))
        .all();
      return Object.fromEntries(
        rows.map(({ name, generation }) => [name, generation])
      );
    });
  }

  /** The generations of tables `names` of the pinned schema, now. */
  #generationsOf(
    pinned: PinnedSchema,
    names: readonly string[]
  ): Record<string, number> {
    const byId = new Map<string, string>();
    for (const name of names) {
      const tableId = Object.hasOwn(pinned.tableIds, name)
        ? pinned.tableIds[name]
        : undefined;
      if (tableId !== undefined) {
        byId.set(tableId, name);
      }
    }
    if (byId.size === 0) {
      return {};
    }
    const rows = this.#db
      .select({ tableId: tables.tableId, generation: tables.generation })
      .from(tables)
      .where(inArray(tables.tableId, [...byId.keys()]))
      .all();
    return Object.fromEntries(
      rows.map(({ tableId, generation }) => [
        byId.get(tableId) ?? tableId,
        generation,
      ])
    );
  }

  /**
   * One page of `query` for `reader` (store-cursors.ts has its threat
   * model): its cursor opened first, against what this request and scope
   * bind it to, under this store's key; the page read in one transaction;
   * and the next page's cursor sealed for the same binding, when more
   * follow.
   */
  async #page(
    storeId: StoreId,
    reader: ReadScope,
    pinned: PinnedSchema,
    query: QueryRequest,
    preview: Preview | undefined
  ): Promise<ReadResult> {
    const { terminal } = query;
    if (terminal.kind !== "paginate") {
      throw new Error("Not a page");
    }
    const keys = await this.#cursorKeys(storeId);
    const binding: CursorBinding = {
      storeId,
      schemaHash: reader.schemaHash,
      consumer: reader.consumer,
      principal: reader.principal,
      appMember: reader.appMember,
      appBuilder: reader.appBuilder,
      table: query.table,
      index: query.index,
      range: query.range,
      filter: query.filter,
      order: query.order,
    };
    const anchor =
      terminal.cursor === null
        ? null
        : await openCursor(keys, binding, terminal.cursor);
    const { value: read, generations } = this.#readIn(
      storeId,
      pinned,
      reader,
      query.table,
      preview,
      (statements) =>
        indexRequired(() => readPage(statements, pinned, reader, query, anchor))
    );
    const value: PageAnswer =
      read.hasMore && read.last !== undefined
        ? {
            items: read.items,
            nextCursor: await sealCursor(keys, binding, read.last),
            hasMore: true,
          }
        : { items: read.items, nextCursor: null, hasMore: false };
    return { value, generations };
  }

  /**
   * The keys this store seals and tags its cursors with, derived from one
   * random key kept in its own SQLite: minted by the store's first page,
   * cleared when the store is purged, derived once per object.
   */
  async #cursorKeys(storeId: StoreId): Promise<CursorKeys> {
    if (this.#keys !== undefined) {
      return this.#keys;
    }
    const hex = this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      const row = this.#db.select({ key: store.cursorKey }).from(store).get();
      if (row?.key !== null && row?.key !== undefined) {
        return row.key;
      }
      const made = toHex(crypto.getRandomValues(new Uint8Array(32)));
      this.#db.update(store).set({ cursorKey: made }).run();
      return made;
    });
    this.#keys = await cursorKeysOf(hex);
    return this.#keys;
  }

  /**
   * SQLite's plan for the statement `request` (a query) would run for
   * `scope`, planned exactly as `read` plans it: for tests, which reach it
   * through this host inside the object, never over RPC.
   */
  async explain(
    storeId: StoreId,
    scope: ReadScope,
    request: QueryRequest
  ): Promise<string> {
    const reader = readScopeSchema.parse(scope);
    const pinned = await this.#pinned(storeId, reader.schemaHash);
    const table = readableTable(pinned, reader, request.table);
    const plan = planQuery(pinned, reader, table, request, {
      documents: true,
    });
    return this.ctx.storage.sql
      .exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${plan.statement}`,
        ...plan.params
      )
      .toArray()
      .map(({ detail }) => detail)
      .join("\n");
  }
  /**
   * SQLite's plan for each statement a page of `request` reads after
   * `anchor`, one per seek, planned as `read` plans them: for tests, in
   * the object, never over RPC.
   */
  async explainPage(
    storeId: StoreId,
    scope: ReadScope,
    request: QueryRequest,
    anchor: Anchor
  ): Promise<string[]> {
    const reader = readScopeSchema.parse(scope);
    const pinned = await this.#pinned(storeId, reader.schemaHash);
    return pagePlans(this.ctx.storage.sql, pinned, reader, request, anchor).map(
      (plan) =>
        this.ctx.storage.sql
          .exec<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${plan.statement}`,
            ...plan.params
          )
          .toArray()
          .map(({ detail }) => detail)
          .join("\n")
    );
  }

  /**
   * The schema `schemaHash` as this store recorded it, with its tables'
   * IDs and its indexes' physical names: read and planned once per object,
   * since neither ever changes for a hash. `data.unknown_schema` for a
   * hash the store wasn't handed.
   */
  async #pinned(storeId: StoreId, schemaHash: string): Promise<PinnedSchema> {
    const known = this.#schemas.get(schemaHash);
    if (known !== undefined) {
      return known;
    }
    const row = this.ctx.storage.transactionSync(() => {
      this.#bind(storeId, false);
      return this.#db
        .select({ manifest: schemas.manifest })
        .from(schemas)
        .where(eq(schemas.schemaHash, schemaHash))
        .get();
    });
    if (row === undefined) {
      throw dataErrors.create("data.unknown_schema");
    }
    const { manifest } = readSchemaManifest(row.manifest);
    const tableIds = Object.fromEntries(
      this.#db
        .select({ name: tables.name, tableId: tables.tableId })
        .from(tables)
        .all()
        .map(({ name, tableId }) => [name, tableId])
    );
    const pinned: PinnedSchema = {
      manifest,
      tableIds,
      indexes: await planIndexes(manifest, tableIds),
    };
    this.#schemas.set(schemaHash, pinned);
    return pinned;
  }

  /**
   * Claims a mutation's receipt for a new attempt, before its handler
   * runs: a new receipt, or the fence of the one it has moved on, keeping
   * it at least a retention from now. Answers the outcome instead when
   * the mutation committed already, writing nothing;
   * `submission.key_conflict` when the key was used for other input, and
   * `submission.expired` when its receipt expired. Call it only once the
   * caller is authorized in full.
   */
  async claim(input: ClaimInput): Promise<Claimed> {
    const { storeId, scope, key, inputHash, runId, deadline } =
      dataErrors.parse("data.invalid", claimSchema, input);
    const receiptId = await sha256Hex(
      canonicalJson({ storeId, scope: { ...scope }, key: [...key] })
    );
    const claimed = this.ctx.storage.transactionSync((): Claimed => {
      this.#bind(storeId);
      const now = Date.now();
      const receipt = this.#db
        .select()
        .from(receipts)
        .where(eq(receipts.receiptId, receiptId))
        .get();
      if (receipt === undefined) {
        this.#db
          .insert(receipts)
          .values({
            receiptId,
            scope: canonicalJson({ ...scope }),
            principal: scope.principal,
            runId,
            inputHash,
            fence: 1,
            deadline,
            createdAt: now,
            retainUntil: now + retentionMs,
          })
          .run();
        return { held: { receiptId, fence: 1 } };
      }
      if (receipt.expiredAt !== null) {
        throw submissionErrors.create("submission.expired");
      }
      if (receipt.inputHash !== inputHash) {
        throw submissionErrors.create("submission.key_conflict");
      }
      if (receipt.outcome !== null) {
        return { outcome: outcomeOf(receipt.outcome) };
      }
      const fence = receipt.fence + 1;
      this.#db
        .update(receipts)
        .set({
          fence,
          deadline,
          retainUntil: Math.max(receipt.retainUntil, now + retentionMs),
        })
        .where(eq(receipts.receiptId, receiptId))
        .run();
      return { held: { receiptId, fence } };
    });
    await this.schedule();
    return claimed;
  }

  /**
   * Commits a mutation's staged writes in one transaction, with its
   * receipt's outcome (its inserted IDs and what it returned) and its
   * outbox entries, or nothing: the attempt must hold the receipt's
   * current fence (`submission.superseded`) before its deadline
   * (`submission.deadline_passed`); every table it read must still be at
   * the generation it read (`data.reads_changed`); each guard's record
   * must still be at the revision read, and each write's record at its
   * expected revision (a record the commit inserted is at 1), otherwise
   * `data.conflict`. Every write is checked against the access of the
   * schema it is pinned to, for the principal and the roles core resolved
   * just before (`#apply`). An attempt whose mutation another attempt
   * committed meanwhile answers that outcome. Inserted records are owned
   * by the principal, under the IDs core minted. An intent whose kind
   * nothing in `consumers` takes is refused
   * (`submission.intent_unsupported`).
   */
  async commit(input: Commit, consumers: OutboxConsumers): Promise<Committed> {
    const {
      storeId,
      principal,
      roles,
      schemaHash,
      receipt: held,
      stagedAt,
      guards,
      readSet,
      writes,
      intents,
      result,
    } = dataErrors.parse("data.invalid", commitSchema, input);
    const pinned = await this.#pinned(storeId, schemaHash);
    const committed = this.ctx.storage.transactionSync((): Committed => {
      this.#bind(storeId);
      const now = Date.now();
      const receipt = this.#db
        .select()
        .from(receipts)
        .where(eq(receipts.receiptId, held.receiptId))
        .get();
      if (receipt === undefined || receipt.principal !== principal.userId) {
        throw dataErrors.create("data.receipt_invalid");
      }
      if (receipt.expiredAt !== null) {
        throw submissionErrors.create("submission.expired");
      }
      if (receipt.outcome !== null) {
        return outcomeOf(receipt.outcome);
      }
      if (receipt.fence !== held.fence) {
        throw submissionErrors.create("submission.superseded");
      }
      // The deadline its attempt claimed with: the fence says this
      // attempt made the last claim.
      if (now >= receipt.deadline) {
        throw submissionErrors.create("submission.deadline_passed");
      }
      if (stagedAt > now + stagedAheadMs) {
        throw dataErrors.create("data.invalid", {
          issues: ["stagedAt: Later than the store's clock allows"],
        });
      }
      if (
        intents.some(({ kind }) => consumerFor(consumers, kind) === undefined)
      ) {
        throw submissionErrors.create("submission.intent_unsupported");
      }
      // The explicit guards first: a record the mutation asserted a
      // revision of, now at another, is a conflict for its caller
      // (`data.conflict`), never a stale read set to run again for, which
      // could commit a fallback its rerun reached instead.
      const { staged, inserted } = this.#apply(
        pinned,
        principal.userId,
        roles,
        writes,
        guards,
        () => {
          const current = this.#generationsOf(pinned, Object.keys(readSet));
          for (const [table, generation] of Object.entries(readSet)) {
            if (current[table] !== generation) {
              throw dataErrors.create("data.reads_changed", { table });
            }
          }
        }
      );
      this.#flush(staged, principal.userId, schemaHash, stagedAt);
      this.#indexReferences(pinned, staged, principal.userId, roles);
      const counted = this.#db
        .update(store)
        .set({ commits: sql`${store.commits} + 1` })
        .returning({ commits: store.commits })
        .get();
      if (counted === undefined) {
        throw new Error("A bound store has no row");
      }
      const outcome: Committed = {
        inserted,
        commit: counted.commits,
        result,
      };
      this.#db
        .update(receipts)
        .set({
          outcome: JSON.stringify(outcome),
          committedAt: now,
          commit: counted.commits,
          retainUntil: Math.max(receipt.retainUntil, now + retentionMs),
        })
        .where(eq(receipts.receiptId, held.receiptId))
        .run();
      for (const [position, intent] of intents.entries()) {
        this.#db
          .insert(outbox)
          .values({
            // The commit's number makes it unique: a key whose tombstone
            // went can commit again under the same receipt ID, and its
            // entries must not pass for the ones a consumer already took.
            id: `${held.receiptId}:${counted.commits}:${position}`,
            receiptId: held.receiptId,
            position,
            kind: intent.kind,
            intent: JSON.stringify(intent),
            createdAt: now,
            nextAttemptAt: now,
          })
          .run();
      }
      return outcome;
    });
    await this.schedule();
    return committed;
  }

  /**
   * The records `writes` change, as they would be after them, checked
   * against the store as it is (call it inside a transaction): each
   * guard's record still at its revision; each write to a table of the
   * pinned schema that the schema lets `roles` write (`data.write_denied`
   * otherwise; `data.unknown_table` for a table it hasn't); a record an
   * `owner` table's write changes owned by `principal`, as one that
   * doesn't exist and one at another revision are (`data.conflict`, the
   * same for all three, so a write learns nothing of a record it may not
   * change); an insert's ID not in use. What a commit writes, and what a
   * preview applies before its read.
   */
  #apply(
    pinned: PinnedSchema,
    principal: string,
    roles: WriterRoles,
    writes: readonly StoredWrite[],
    guards: readonly { table: string; id: string; expectedRevision: number }[],
    afterGuards?: () => void
  ): { staged: Staged[]; inserted: string[] } {
    const tableIdOf = (table: string): string => {
      const tableId = Object.hasOwn(pinned.tableIds, table)
        ? pinned.tableIds[table]
        : undefined;
      if (
        tableId === undefined ||
        !Object.hasOwn(pinned.manifest.tables, table)
      ) {
        throw dataErrors.create("data.unknown_table", { table });
      }
      return tableId;
    };
    /** Whether `roles` may write `table`, and whether only their own records. */
    const writable = (table: string): { tableId: string; own: boolean } => {
      const tableId = tableIdOf(table);
      const mode = pinned.manifest.tables[table]?.access.write ?? "none";
      const admitted =
        mode === "owner" ||
        (mode === "appMembers" && (roles.appMember || roles.appBuilder)) ||
        (mode === "appBuilders" && roles.appBuilder);
      if (!admitted) {
        throw dataErrors.create("data.write_denied", { table });
      }
      return { tableId, own: mode === "owner" };
    };
    const staged = new Map<string, Staged>();
    const stage = (
      table: string,
      tableId: string,
      recordId: string
    ): Staged => {
      const key = keyOf(tableId, recordId);
      const known = staged.get(key);
      if (known !== undefined) {
        return known;
      }
      const base = this.#db
        .select()
        .from(records)
        .where(
          and(eq(records.tableId, tableId), eq(records.recordId, recordId))
        )
        .get();
      const entry: Staged = {
        table,
        tableId,
        recordId,
        base,
        fields: base === undefined ? null : fieldsOf(base),
      };
      staged.set(key, entry);
      return entry;
    };
    /**
     * The staged record and its fields, if it exists at `expected` (and,
     * with `own`, is the principal's); otherwise a conflict.
     */
    const at = (
      table: string,
      tableId: string,
      recordId: string,
      expected: number,
      own: boolean
    ): { entry: Staged; fields: StoreFields } => {
      const entry = stage(table, tableId, recordId);
      const { fields, base } = entry;
      const revision = base?.revision ?? 1;
      // A record an earlier write of this commit changed is shown to the
      // mutation's staged reads at the revision its commit will give it
      // (one more, once, if its fields differ): a later write may assert
      // that, as well as the revision it was read at before the change.
      const shown =
        base !== undefined &&
        fields !== null &&
        storedText(fields) !== base.valueJson
          ? base.revision + 1
          : revision;
      const owned = base === undefined || base.ownerId === principal;
      if (
        fields === null ||
        (expected !== revision && expected !== shown) ||
        (own && !owned)
      ) {
        throw conflict(table, recordId);
      }
      return { entry, fields };
    };

    for (const guard of guards) {
      at(
        guard.table,
        tableIdOf(guard.table),
        guard.id,
        guard.expectedRevision,
        false
      );
    }
    afterGuards?.();
    const inserted: string[] = [];
    for (const write of writes) {
      const { tableId, own } = writable(write.table);
      if (write.op === "insert") {
        const entry = stage(write.table, tableId, write.id);
        if (entry.base !== undefined || entry.fields !== null) {
          throw conflict(write.table, write.id);
        }
        entry.fields = write.fields;
        inserted.push(write.id);
        continue;
      }
      const { entry, fields } = at(
        write.table,
        tableId,
        write.id,
        write.expectedRevision,
        own
      );
      if (write.op === "delete") {
        entry.fields = null;
      } else if (write.op === "replace") {
        // Fields the pinned table doesn't declare are a newer version's,
        // kept in the contract (`defineTables`): a replacement by an older
        // version keeps them, as a patch does, and never strips them.
        const declared = pinned.manifest.tables[write.table]?.fields ?? {};
        entry.fields = {
          ...Object.fromEntries(
            Object.entries(fields).filter(
              ([name]) => !Object.hasOwn(declared, name)
            )
          ),
          ...write.fields,
        };
      } else {
        const unset = new Set(write.unset);
        entry.fields = Object.fromEntries(
          Object.entries({ ...fields, ...write.fields }).filter(
            ([name]) => !unset.has(name)
          )
        );
      }
    }
    return { staged: [...staged.values()], inserted };
  }

  /**
   * Keeps the references the records a commit changed make
   * (`sdk_record_refs`), as its schema declares them (store-references.ts),
   * then refuses (`data.referenced`) the commit if a record it deleted is
   * still referred to by a record it didn't (restrict): call it inside the
   * commit's transaction, after its writes, so the refusal undoes them all.
   * A record referring to itself, or to another this commit deletes too,
   * doesn't keep it.
   *
   * A reference a record didn't hold before must name a record that
   * exists, after this commit, and that `principal` with `roles` may read
   * under the pinned schema (`#referable`); otherwise the commit is
   * refused (`data.reference_invalid`, the same whether the record is
   * missing or unreadable, so it learns nothing of others' records). So
   * nobody can keep a record they may not see from being deleted by
   * referring to it. A reference the record already held is kept as it
   * is, whoever may read its record now.
   *
   * A record's references are read from all its fields as the store's
   * contract declares them (`#contractNow`), not only the pinned table's:
   * a field a newer version wrote, which an older version's write keeps,
   * still refers, and the contract fixes each field's descriptor for good
   * (`defineTables` refuses changing one), so a record ID stays one.
   */
  #indexReferences(
    pinned: PinnedSchema,
    staged: readonly Staged[],
    principal: string,
    roles: WriterRoles
  ): void {
    const byKey = new Map(
      staged.map((entry) => [keyOf(entry.tableId, entry.recordId), entry])
    );
    const contract = this.#contractNow();
    let storeTables: ReadonlyMap<string, string> | undefined;
    const tableIdOf = (name: string): string | undefined => {
      storeTables ??= new Map(
        this.#tableRows().map((row) => [row.name, row.tableId])
      );
      return storeTables.get(name);
    };
    for (const { table, tableId, recordId, base, fields } of staged) {
      const held = new Set<string>();
      if (base !== undefined) {
        const where = and(
          eq(recordRefs.tableId, tableId),
          eq(recordRefs.recordId, recordId)
        );
        for (const row of this.#db
          .select({ to: recordRefs.toTableId, id: recordRefs.toRecordId })
          .from(recordRefs)
          .where(where)
          .all()) {
          held.add(keyOf(row.to, row.id));
        }
        this.#db.delete(recordRefs).where(where).run();
      }
      const declared = (contract ?? pinned.manifest).tables[table]?.fields;
      if (fields === null || declared === undefined) {
        continue;
      }
      for (const reference of recordReferences(declared, fields)) {
        const toTableId = tableIdOf(reference.table);
        if (
          toTableId === undefined ||
          (!held.has(keyOf(toTableId, reference.id)) &&
            !this.#referable(pinned, byKey, principal, roles, {
              table: reference.table,
              tableId: toTableId,
              recordId: reference.id,
            }))
        ) {
          throw dataErrors.create("data.reference_invalid", {
            table,
            id: recordId,
          });
        }
        this.#db
          .insert(recordRefs)
          .values({ tableId, recordId, toTableId, toRecordId: reference.id })
          .onConflictDoNothing()
          .run();
      }
    }
    for (const { table, tableId, recordId, base, fields } of staged) {
      if (base === undefined || fields !== null) {
        continue;
      }
      const referred = this.#db
        .select({ one: sql`1` })
        .from(recordRefs)
        .where(
          and(
            eq(recordRefs.toTableId, tableId),
            eq(recordRefs.toRecordId, recordId)
          )
        )
        .get();
      if (referred !== undefined) {
        // The record's own table and ID only: nothing of what refers to
        // it, which may be another's.
        throw dataErrors.create("data.referenced", { table, id: recordId });
      }
    }
  }

  /**
   * The store's contract as its row holds it now (call it inside a
   * transaction), or undefined while it has none. Read again only when its
   * hash moved on; its hash was checked when it was set (`defineTables`).
   */
  #contractNow(): SchemaManifest | undefined {
    const row = this.#db
      .select({
        hash: store.contractHash,
        manifest: store.contractManifest,
      })
      .from(store)
      .get();
    if (
      row?.hash === null ||
      row?.hash === undefined ||
      row.manifest === null
    ) {
      return undefined;
    }
    if (this.#contract?.hash !== row.hash) {
      this.#contract = {
        hash: row.hash,
        manifest: readSchemaManifest(row.manifest).manifest,
      };
    }
    return this.#contract.manifest;
  }

  /**
   * Whether record `target` exists once the commit's `staged` records are
   * written, and `principal` with `roles` may read it under the pinned
   * schema's access: its table's read mode admits them, and for an
   * `owner` table, the record is theirs (one this commit inserts is).
   */
  #referable(
    pinned: PinnedSchema,
    staged: ReadonlyMap<string, Staged>,
    principal: string,
    roles: WriterRoles,
    target: { table: string; tableId: string; recordId: string }
  ): boolean {
    const mode = Object.hasOwn(pinned.manifest.tables, target.table)
      ? pinned.manifest.tables[target.table]?.access.read
      : undefined;
    const admitted =
      mode === "owner" ||
      (mode === "appMembers" && (roles.appMember || roles.appBuilder)) ||
      (mode === "appBuilders" && roles.appBuilder);
    if (!admitted) {
      return false;
    }
    const entry = staged.get(keyOf(target.tableId, target.recordId));
    let owner: string | undefined;
    if (entry === undefined) {
      owner = this.#db
        .select({ owner: records.ownerId })
        .from(records)
        .where(
          and(
            eq(records.tableId, target.tableId),
            eq(records.recordId, target.recordId)
          )
        )
        .get()?.owner;
    } else if (entry.fields !== null) {
      owner = entry.base?.ownerId ?? principal;
    }
    return owner !== undefined && (mode !== "owner" || owner === principal);
  }

  /**
   * Writes what a commit (or a preview) staged, changing only the records
   * it changed, stamped with `now`, the time core staged them.
   */
  #flush(
    staged: readonly Staged[],
    ownerId: string,
    schemaHash: string,
    now: number
  ): void {
    // The tables whose records this commit changes: each one's generation
    // moves on once, so a read of it (even one that matched nothing) is
    // known to be stale.
    const changed = new Set<string>();
    for (const { table, tableId, recordId, base, fields } of staged) {
      const where = and(
        eq(records.tableId, tableId),
        eq(records.recordId, recordId)
      );
      if (fields === null) {
        if (base !== undefined) {
          this.#db.delete(records).where(where).run();
          changed.add(tableId);
        }
        continue;
      }
      // Each write's fields were within the limit, but a patch merges
      // into what the record holds, and several patches add up: the
      // document as it would be stored is what must fit.
      const valueJson = storedText(fields);
      if (encoder.encode(valueJson).byteLength > documentMaxBytes) {
        throw dataErrors.create("data.invalid", {
          table,
          id: recordId,
          issues: [`A record holds at most ${documentMaxBytes} bytes`],
        });
      }
      if (base === undefined) {
        this.#db
          .insert(records)
          .values({
            tableId,
            recordId,
            ownerId,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            valueJson,
            schemaHash,
          })
          .run();
        changed.add(tableId);
      } else if (valueJson !== base.valueJson) {
        changed.add(tableId);
        this.#db
          .update(records)
          .set({
            revision: base.revision + 1,
            updatedAt: Math.max(now, base.updatedAt),
            valueJson,
            schemaHash,
          })
          .where(where)
          .run();
      }
    }
    if (changed.size > 0) {
      this.#db
        .update(tables)
        .set({ generation: sql`${tables.generation} + 1` })
        .where(inArray(tables.tableId, [...changed]))
        .run();
    }
  }

  /**
   * Hands the outbox's due entries over to `consumers`, oldest first, one
   * at a time, until none are due or the drain's budget is spent (checked
   * before each entry but the first). Each is leased at the drain's time
   * when its turn comes, and settled, or put back for later when the
   * hand-over failed (settled as `outbox.attempts_exhausted` past
   * `maxAttempts`), only while the drain still holds that lease. An entry
   * whose kind nothing takes any more (its consumer went in a later
   * release, or not yet in one rolling out) fails its attempt, and is
   * settled as `outbox.no_consumer` once its attempts run out: owed to
   * nobody for good, it would otherwise keep its receipt forever. Run by
   * the alarm.
   */
  async drainOutbox(
    consumers: OutboxConsumers,
    {
      now = new Date(),
      timeoutMs = defaultTimeoutMs,
      budgetMs = defaultBudgetMs,
      maxAttempts = defaultMaxAttempts,
    }: DrainOptions = {}
  ): Promise<void> {
    assertTimeout(timeoutMs);
    const started = Date.now();
    const clock = () => now.getTime() + (Date.now() - started);
    const handed = new Set<string>();
    for (;;) {
      const due = this.#db
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(isNull(outbox.settledAt), lte(outbox.nextAttemptAt, clock()))
        )
        .orderBy(asc(sql`rowid`))
        .limit(page)
        .all()
        .filter(({ id }) => !handed.has(id));
      if (due.length === 0) {
        return;
      }
      for (const { id } of due) {
        if (handed.size > 0 && Date.now() - started >= budgetMs) {
          return;
        }
        handed.add(id);
        // One after the other: in the order they were committed.
        // oxlint-disable-next-line no-await-in-loop -- see above
        await this.#handOne(id, consumers, clock, timeoutMs, maxAttempts);
      }
    }
  }

  /** Leases, hands over and settles entry `id`, if it is still due. */
  async #handOne(
    id: string,
    consumers: OutboxConsumers,
    clock: () => number,
    timeoutMs: number,
    maxAttempts: number
  ): Promise<void> {
    const leasedAt = clock();
    // The lease outlasts the hand-over, with room for the writes around it.
    const until = leasedAt + timeoutMs * 2;
    const leased = this.#db
      .update(outbox)
      .set({ nextAttemptAt: until })
      .where(
        and(
          eq(outbox.id, id),
          isNull(outbox.settledAt),
          lte(outbox.nextAttemptAt, leasedAt)
        )
      )
      .returning({
        kind: outbox.kind,
        intent: outbox.intent,
        attempts: outbox.attempts,
      })
      .get();
    if (leased === undefined) {
      return;
    }
    /** Settles the entry, nobody to hand it to, while this drain holds it. */
    const settleUndeliverable = (code: string): void => {
      this.#db
        .update(outbox)
        .set({ settledAt: clock(), undeliverable: code })
        .where(
          and(
            eq(outbox.id, id),
            isNull(outbox.settledAt),
            eq(outbox.nextAttemptAt, until)
          )
        )
        .run();
    };
    // An entry a later release can't read is settled, not left to stop
    // every drain behind it: no retry would make it readable.
    const intent = intentOf(leased.intent);
    if (intent === undefined) {
      log.warn("outbox.unreadable", { id, kind: leased.kind });
      settleUndeliverable("outbox.unreadable");
      return;
    }
    const { attempts } = leased;
    // No consumer for its kind (a rollback, or a release rolling out) is
    // a failed attempt like any other: the entry waits for one to come
    // back, and settles as `outbox.no_consumer` only once its attempts
    // run out.
    const consumer = consumerFor(consumers, leased.kind);
    const result =
      consumer === undefined
        ? { failed: new Error("Nothing takes this kind of entry") }
        : await handOver(consumer, { id, intent, attempts }, timeoutMs);
    const held = and(
      eq(outbox.id, id),
      isNull(outbox.settledAt),
      eq(outbox.nextAttemptAt, until)
    );
    const handedAt = clock();
    if ("settled" in result) {
      this.#db
        .update(outbox)
        .set({
          settledAt: handedAt,
          undeliverable:
            result.settled === "delivered"
              ? null
              : result.settled.undeliverable,
        })
        .where(held)
        .run();
      return;
    }
    log.warn("outbox.delivery_failed", {
      id,
      kind: leased.kind,
      ...errorFields(result.failed),
    });
    const failed = attempts + 1;
    this.#db
      .update(outbox)
      .set(
        failed >= maxAttempts
          ? {
              attempts: failed,
              settledAt: handedAt,
              undeliverable:
                consumer === undefined
                  ? "outbox.no_consumer"
                  : "outbox.attempts_exhausted",
            }
          : { attempts: failed, nextAttemptAt: handedAt + backoffMs(failed) }
      )
      .where(held)
      .run();
  }

  /**
   * Expires the receipts kept long enough by `now`, and deletes the
   * tombstones kept long enough. A receipt whose outbox still owes an
   * entry is not due; one whose run is live is looked at again a day
   * later; the others lose their outcome and settled entries and stay as
   * tombstones. Each page's transaction checks again that each receipt is
   * still due, so a claim or commit landing while the runs were looked up
   * keeps its receipt. Goes on a page at a time until nothing is due or
   * its budget is spent; the next alarm continues. Run by the alarm.
   */
  async sweepReceipts(
    now: Date,
    {
      budgetMs = sweepBudgetMs,
      live: liveOf = async (runIds) => await liveRuns(this.env, runIds),
    }: SweepOptions = {}
  ): Promise<void> {
    const started = Date.now();
    const spent = () => Date.now() - started >= budgetMs;
    const at = now.getTime();
    const stillDue = (ids: readonly string[]) =>
      and(
        inArray(receipts.receiptId, [...ids]),
        isNull(receipts.expiredAt),
        lte(receipts.retainUntil, at),
        nothingOwed
      );
    for (;;) {
      const due = this.#db
        .select({ receiptId: receipts.receiptId, runId: receipts.runId })
        .from(receipts)
        .where(
          and(
            isNull(receipts.expiredAt),
            lte(receipts.retainUntil, at),
            nothingOwed
          )
        )
        .orderBy(asc(receipts.retainUntil), asc(receipts.receiptId))
        .limit(page)
        .all();
      if (due.length === 0) {
        break;
      }
      // One page after the other: each reads what the last left.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const live = await liveOf(
        due.flatMap(({ runId }) => (runId === null ? [] : [runId]))
      );
      const isKept = ({ runId }: { runId: string | null }) =>
        runId !== null && live.has(runId);
      const kept = due.filter(isKept).map(({ receiptId }) => receiptId);
      const expiring = due
        .filter((receipt) => !isKept(receipt))
        .map(({ receiptId }) => receiptId);
      this.ctx.storage.transactionSync(() => {
        if (kept.length > 0) {
          this.#db
            .update(receipts)
            .set({ retainUntil: at + liveRunRecheckMs })
            .where(stillDue(kept))
            .run();
        }
        if (expiring.length === 0) {
          return;
        }
        const expired = this.#db
          .update(receipts)
          .set({
            expiredAt: at,
            outcome: null,
            committedAt: null,
            commit: null,
          })
          .where(stillDue(expiring))
          .returning({ receiptId: receipts.receiptId })
          .all()
          .map(({ receiptId }) => receiptId);
        if (expired.length > 0) {
          this.#db
            .delete(outbox)
            .where(inArray(outbox.receiptId, expired))
            .run();
        }
      });
      if (spent()) {
        return;
      }
      if (due.length < page) {
        break;
      }
    }
    // Tombstones old enough, a page at a time.
    while (!spent()) {
      const gone = this.ctx.storage.sql.exec(
        "DELETE FROM sdk_mutation_receipts WHERE rowid IN (SELECT rowid FROM sdk_mutation_receipts WHERE expired_at IS NOT NULL AND expired_at <= ? LIMIT ?)",
        at - tombstoneMs,
        page
      ).rowsWritten;
      if (gone < page) {
        return;
      }
    }
  }

  /**
   * The alarm's work: hands the outbox over to `consumers` and sweeps the
   * receipts, then sets the alarm again. Either failing (D1 out, say) is
   * logged and retried a while later, never left without an alarm.
   */
  async runAlarm(
    consumers: OutboxConsumers,
    sweep: SweepOptions = {},
    purge: PurgeOptions = {}
  ): Promise<void> {
    if (this.#deleted()) {
      let failed = false;
      try {
        await this.#purgeDeleted(purge);
      } catch (error) {
        failed = true;
        log.error("store.purge_failed", errorFields(error));
      } finally {
        await this.schedule(failed ? alarmRetryMs : alarmGapMs);
      }
      return;
    }
    let failed = false;
    try {
      await this.drainOutbox(consumers);
    } catch (error) {
      failed = true;
      log.error("store.drain_failed", errorFields(error));
    }
    try {
      await this.sweepReceipts(new Date(), sweep);
    } catch (error) {
      failed = true;
      log.error("store.sweep_failed", errorFields(error));
    } finally {
      await this.schedule(failed ? alarmRetryMs : alarmGapMs);
    }
  }

  /**
   * Sets the alarm for the next time something is due, at least `gapMs`
   * from now, unless it is set sooner already: an outbox entry owed (of
   * any kind, as the drain settles those nothing takes), a receipt the
   * sweep may expire (none whose outbox owes an entry, which the sweep
   * skips), or a tombstone. So nothing due is left without an alarm, and
   * nothing the alarm can't act on sets one.
   */
  async schedule(gapMs = alarmGapMs): Promise<void> {
    if (this.#deleted()) {
      // Only recording it in core and its purge are left, if anything.
      // EXISTS terms rather than a UNION: SQLite here caps a compound
      // SELECT at five terms.
      const [left] = this.ctx.storage.sql
        .exec<{ left: number }>(
          `SELECT (EXISTS (SELECT 1 FROM sdk_store WHERE inventoried_at IS NULL) ${purgedTables.map((table) => `OR EXISTS (SELECT 1 FROM ${table})`).join(" ")}) AS left`
        )
        .toArray();
      if (left?.left === 1) {
        await this.ctx.storage.setAlarm(Date.now() + gapMs);
      }
      return;
    }
    const [entry] = this.#db
      .select({ at: min(outbox.nextAttemptAt) })
      .from(outbox)
      .where(isNull(outbox.settledAt))
      .all();
    const [receipt] = this.#db
      .select({ at: min(receipts.retainUntil) })
      .from(receipts)
      .where(and(isNull(receipts.expiredAt), nothingOwed))
      .all();
    const [tombstone] = this.#db
      .select({ at: min(receipts.expiredAt) })
      .from(receipts)
      .where(isNotNull(receipts.expiredAt))
      .all();
    const times = [
      entry?.at,
      receipt?.at,
      typeof tombstone?.at === "number" ? tombstone.at + tombstoneMs : null,
    ].filter((time): time is number => typeof time === "number");
    if (times.length === 0) {
      return;
    }
    const next = Math.max(Math.min(...times), Date.now() + gapMs);
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /** Whether the store was deleted. */
  #deleted(): boolean {
    const bound = this.#db
      .select({ deletedAt: store.deletedAt })
      .from(store)
      .get();
    return bound !== undefined && bound.deletedAt !== null;
  }

  /**
   * Deletes the store for `actor`, unless a receipt still refers to it:
   * one not yet expired (`data.store_in_use`), which a mutation in flight,
   * a retry still to come, a live workflow run or an outbox entry still
   * owed keeps. Checked in the transaction that marks the store deleted
   * (with who and when), so no claim can land between the check and the
   * mark; every call after it is refused (`#bind`). Answers when it was
   * deleted. Deleting a deleted store changes nothing and answers the
   * first deletion, so core can repeat one its inventory didn't record.
   * The alarm records it in core, then purges the records.
   */
  async close(storeId: StoreId, actor: AuditActor): Promise<StoreDeletionMark> {
    const id = storeIdSchema.parse(storeId);
    const deletedBy = JSON.stringify(auditActorSchema.parse(actor));
    if (this.ctx.id.name !== id) {
      throw new Error("This object holds another store");
    }
    const mark = this.ctx.storage.transactionSync((): StoreDeletionMark => {
      const now = Date.now();
      const bound = this.#db
        .select({
          storeId: store.storeId,
          deletedAt: store.deletedAt,
          deletedBy: store.deletedBy,
        })
        .from(store)
        .get();
      if (bound === undefined) {
        // Never used: nothing refers to it.
        this.#db
          .insert(store)
          .values({
            only: 1,
            storeId: id,
            createdAt: now,
            deletedAt: now,
            deletedBy,
          })
          .run();
        return { deletedAt: now, deletedBy: actor };
      }
      if (bound.storeId !== id) {
        throw new Error("This object holds another store");
      }
      // Deleted already: the first deletion's mark, whoever asks now.
      if (bound.deletedAt !== null) {
        return markOf(bound);
      }
      const [held] = this.#db
        .select({ count: count() })
        .from(receipts)
        .where(isNull(receipts.expiredAt))
        .all();
      const receiptsHeld = held?.count ?? 0;
      if (receiptsHeld > 0) {
        throw dataErrors.create("data.store_in_use", {
          receipts: receiptsHeld,
        });
      }
      this.#db.update(store).set({ deletedAt: now, deletedBy }).run();
      return { deletedAt: now, deletedBy: actor };
    });
    await this.schedule(0);
    return mark;
  }

  /**
   * A deleted store's alarm: records the deletion in core first (store-
   * deletion.ts), then purges, a page per transaction, table after table,
   * until nothing is left but the deletion mark or its time is up; the
   * next alarm continues (`schedule`).
   */
  async #purgeDeleted({
    page: purgePageSize = purgePage,
    budgetMs = purgeBudgetMs,
  }: PurgeOptions): Promise<void> {
    const bound = this.#db.select().from(store).get();
    if (bound === undefined) {
      throw new Error("A deleted store has no deletion mark");
    }
    if (bound.inventoriedAt === null) {
      const storeId = storeIdSchema.parse(bound.storeId);
      await recordStoreDeleted(this.env, storeId, markOf(bound));
      // Only once core's inventory shows it: a row that went missing
      // (or a batch that didn't land) is retried, never purged past.
      if (!(await inventoriedDeleted(this.env, storeId))) {
        throw new Error("Core's inventory doesn't show the store deleted");
      }
      this.#db.update(store).set({ inventoriedAt: Date.now() }).run();
    }
    // The cursor key goes with what it sealed: nothing is left to page.
    this.#db.update(store).set({ cursorKey: null }).run();
    this.#keys = undefined;
    const started = Date.now();
    for (const table of purgedTables) {
      for (;;) {
        const removed = this.ctx.storage.transactionSync(
          () =>
            this.ctx.storage.sql.exec(
              `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ?)`,
              purgePageSize
            ).rowsWritten
        );
        if (removed === 0) {
          break;
        }
        if (Date.now() - started >= budgetMs) {
          return;
        }
      }
    }
  }

  /** The ID of the table named `name`, or `data.unknown_table`. */
  #tableId(name: string): string {
    const row = this.#db
      .select({ tableId: tables.tableId })
      .from(tables)
      .where(eq(tables.name, name))
      .get();
    if (row === undefined) {
      throw dataErrors.create("data.unknown_table", { table: name });
    }
    return row.tableId;
  }

  /**
   * Holds this object to one store: the store whose ID is the object's
   * name (data-stores.ts addresses it by name), recorded by the first
   * call. A call for any other store fails, and so does every call to an
   * object not reached by a store's ID, so no object serves a store it
   * wasn't made for.
   */
  #bind(storeId: StoreId, create = true): void {
    const id = storeIdSchema.parse(storeId);
    if (this.ctx.id.name !== id) {
      throw new Error("This object holds another store");
    }
    const bound = this.#db
      .select({ storeId: store.storeId, deletedAt: store.deletedAt })
      .from(store)
      .get();
    if (bound === undefined) {
      // A read creates nothing: a store no schema was handed holds none.
      if (!create) {
        throw dataErrors.create("data.unknown_schema");
      }
      this.#db
        .insert(store)
        .values({ only: 1, storeId: id, createdAt: Date.now() })
        .run();
      return;
    }
    if (bound.storeId !== id) {
      throw new Error("This object holds another store");
    }
    // Deleted: refused whatever core's inventory says, so a deleted store
    // stays deleted even if its inventory row were wrong.
    if (bound.deletedAt !== null) {
      throw dataErrors.create("data.store_unavailable");
    }
  }
}
