import { sha256Hex } from "@grasp-os/shared/encoding";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  claimSchema,
  commitSchema,
  dataErrors,
  documentMaxBytes,
  recordIdSchema,
  storeIntentSchema,
  storeMaxTables,
  storedFieldsSchema,
  tableNameSchema,
} from "@grasp-os/shared/stores";
import type {
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  StoreFields,
  StoredRecord,
} from "@grasp-os/shared/stores";
import {
  submissionErrors,
  submissionRetentionDays,
  submissionTombstoneDays,
} from "@grasp-os/shared/submissions";
import {
  and,
  asc,
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
  records,
  store,
  tables,
} from "./db/data-store/schema.ts";
import { liveRuns } from "./live-runs.ts";
import {
  backoffMs,
  defaultBudgetMs,
  defaultMaxAttempts,
  defaultTimeoutMs,
  handOver,
} from "./outbox-delivery.ts";
import type { DrainOptions, OutboxConsumers } from "./outbox-delivery.ts";

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
//   settled only by the lease holder, and keeps one ID however often it
//   is handed over. A kind nothing takes can't be staged; one whose
//   consumer went in a later release is settled as `outbox.no_consumer`,
//   so it doesn't keep its receipt forever.
// - The alarm spins, or stops: it is set only for what it can act on (an
//   owed entry, a receipt the sweep may expire, a tombstone), never
//   sooner than a second away, again after work that failed (a while
//   later), and on every wake-up, so a commit whose object died before
//   setting it is still drained. Its drain and sweep are each bounded in
//   time; the next alarm continues.
// - A caller bends time or delivery: the object's RPC methods take no
//   clock, consumers or budget; only tests choose them, through this host
//   inside the object.

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

const committedSchema = z.strictObject({
  inserted: z.array(z.string()),
  commit: z.number().int(),
});

/** A committed receipt's outcome, which `commit` wrote from a `Committed`. */
const outcomeOf = (stored: string): Committed =>
  committedSchema.parse(JSON.parse(stored));

/** Whether a receipt's outbox owes no entry, which the sweep requires. */
const nothingOwed = sql`NOT EXISTS (SELECT 1 FROM ${outbox} WHERE ${outbox.receiptId} = ${receipts.receiptId} AND ${outbox.settledAt} IS NULL)`;

/** How long a sweep goes on taking pages, at most, as for Knowledge receipts. */
const sweepBudgetMs = 20_000;

/** The least wait before the alarm comes again, so it never spins. */
const alarmGapMs = 1000;

/** The wait before the alarm tries again after its work failed. */
const alarmRetryMs = 30_000;

const conflict = (table: string, id: string) =>
  dataErrors.create("data.conflict", { table, id });

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

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.#db = drizzle(ctx.storage);
  }

  /**
   * Makes sure the store has a table for each of `names`, minting an ID
   * for each new one, and answers every table's ID by name. A name that
   * differs from an existing one only in case is refused, and so is one
   * past `storeMaxTables`. Tables are never renamed or removed here.
   */
  defineTables(
    storeId: StoreId,
    names: readonly string[]
  ): Record<string, string> {
    const parsed = dataErrors.parse(
      "data.invalid",
      z.array(tableNameSchema).max(storeMaxTables),
      names
    );
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      const now = Date.now();
      for (const name of new Set(parsed)) {
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
            tableId: crypto.randomUUID(),
            name,
            nameKey: name.toLowerCase(),
            createdAt: now,
          })
          .run();
      }
      const all = this.#db
        .select({ name: tables.name, tableId: tables.tableId })
        .from(tables)
        .all();
      if (all.length > storeMaxTables) {
        throw dataErrors.create("data.too_many_tables");
      }
      return Object.fromEntries(
        all.map(({ name, tableId }) => [name, tableId])
      );
    });
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
        return { held: { receiptId, fence: 1, deadline } };
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
      return { held: { receiptId, fence, deadline } };
    });
    await this.schedule();
    return claimed;
  }

  /**
   * Commits a mutation's staged writes in one transaction, with its
   * receipt's outcome and its outbox entries, or nothing: the attempt
   * must hold the receipt's current fence (`submission.superseded`)
   * before its deadline (`submission.deadline_passed`); each guard's
   * record must still be at the revision read, and each write's record at
   * its expected revision (a record the commit inserted is at 1),
   * otherwise `data.conflict`. An attempt whose mutation another attempt
   * committed meanwhile answers that outcome. Inserted records are owned
   * by the principal and get IDs the store mints. An intent whose kind
   * nothing in `consumers` takes is refused
   * (`submission.intent_unsupported`).
   */
  async commit(input: Commit, consumers: OutboxConsumers): Promise<Committed> {
    const {
      storeId,
      principal,
      schemaHash,
      receipt: held,
      guards,
      writes,
      intents,
    } = dataErrors.parse("data.invalid", commitSchema, input);
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
      if (intents.some(({ kind }) => consumers[kind] === undefined)) {
        throw submissionErrors.create("submission.intent_unsupported");
      }
      const staged = new Map<string, Staged>();
      const stage = (table: string, recordId: string): Staged => {
        const tableId = this.#tableId(table);
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
       * The staged record and its fields, if it exists at `expected`;
       * otherwise a conflict.
       */
      const at = (
        table: string,
        recordId: string,
        expected: number
      ): { entry: Staged; fields: StoreFields } => {
        const entry = stage(table, recordId);
        const { fields } = entry;
        const revision = entry.base?.revision ?? 1;
        if (fields === null || revision !== expected) {
          throw conflict(table, recordId);
        }
        return { entry, fields };
      };

      for (const guard of guards) {
        at(guard.table, guard.id, guard.expectedRevision);
      }
      const inserted: string[] = [];
      for (const write of writes) {
        if (write.op === "insert") {
          const recordId = crypto.randomUUID();
          const tableId = this.#tableId(write.table);
          staged.set(keyOf(tableId, recordId), {
            table: write.table,
            tableId,
            recordId,
            base: undefined,
            fields: write.fields,
          });
          inserted.push(recordId);
          continue;
        }
        const { entry, fields } = at(
          write.table,
          write.id,
          write.expectedRevision
        );
        if (write.op === "delete") {
          entry.fields = null;
        } else if (write.op === "replace") {
          entry.fields = write.fields;
        } else {
          const unset = new Set(write.unset);
          entry.fields = Object.fromEntries(
            Object.entries({ ...fields, ...write.fields }).filter(
              ([name]) => !unset.has(name)
            )
          );
        }
      }
      this.#flush([...staged.values()], principal.userId, schemaHash);
      const counted = this.#db
        .update(store)
        .set({ commits: sql`${store.commits} + 1` })
        .returning({ commits: store.commits })
        .get();
      if (counted === undefined) {
        throw new Error("A bound store has no row");
      }
      const outcome: Committed = { inserted, commit: counted.commits };
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
            id: `${held.receiptId}:${position}`,
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

  /** Writes what a commit staged, changing only the records it changed. */
  #flush(staged: readonly Staged[], ownerId: string, schemaHash: string): void {
    const now = Date.now();
    for (const { table, tableId, recordId, base, fields } of staged) {
      const where = and(
        eq(records.tableId, tableId),
        eq(records.recordId, recordId)
      );
      if (fields === null) {
        if (base !== undefined) {
          this.#db.delete(records).where(where).run();
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
      } else if (valueJson !== base.valueJson) {
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
  }

  /**
   * Hands the outbox's due entries over to `consumers`, oldest first, one
   * at a time, until none are due or the drain's budget is spent (checked
   * before each entry but the first). Each is leased at the drain's time
   * when its turn comes, and settled, or put back for later when the
   * hand-over failed (settled as `outbox.attempts_exhausted` past
   * `maxAttempts`), only while the drain still holds that lease. An entry
   * whose kind nothing takes any more (its consumer went in a later
   * release) is settled as `outbox.no_consumer`: owed to nobody, it would
   * otherwise keep its receipt forever. Run by the alarm.
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
    const consumer = consumers[leased.kind];
    if (consumer === undefined) {
      this.#db
        .update(outbox)
        .set({ settledAt: clock(), undeliverable: "outbox.no_consumer" })
        .where(
          and(
            eq(outbox.id, id),
            isNull(outbox.settledAt),
            eq(outbox.nextAttemptAt, until)
          )
        )
        .run();
      return;
    }
    const { attempts } = leased;
    const result = await handOver(
      consumer,
      {
        id,
        intent: storeIntentSchema.parse(JSON.parse(leased.intent)),
        attempts,
      },
      timeoutMs
    );
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
              undeliverable: "outbox.attempts_exhausted",
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
      if (due.length < page || spent()) {
        return;
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
    sweep: SweepOptions = {}
  ): Promise<void> {
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
  #bind(storeId: StoreId): void {
    const id = storeIdSchema.parse(storeId);
    if (this.ctx.id.name !== id) {
      throw new Error("This object holds another store");
    }
    const bound = this.#db.select({ storeId: store.storeId }).from(store).get();
    if (bound === undefined) {
      this.#db
        .insert(store)
        .values({ only: 1, storeId: id, createdAt: Date.now() })
        .run();
      return;
    }
    if (bound.storeId !== id) {
      throw new Error("This object holds another store");
    }
  }
}
