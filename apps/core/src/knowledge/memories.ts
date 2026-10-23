import {
  brainContractVersion,
  brainErrors,
  brainSourceRefSchema,
  commandOptionsSchema,
  memoriesGetInputSchema,
  memoriesListInputSchema,
  receiptsGetInputSchema,
  rememberInputSchema,
} from "@grasp-os/shared/brain-api";
import type {
  BrainSourceRef,
  CommandReceipt,
  MemoryPage,
  MemoryRecord,
} from "@grasp-os/shared/brain-api";
import { toHex } from "@grasp-os/shared/encoding";
import { brainReceiptIdSchema, memoryIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { and, count, desc, eq, gt, lt, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedWhere } from "../audit-outbox.ts";
import {
  brainMemories,
  brainReceipts,
  collections,
  documents,
  versions,
} from "../db/knowledge/schema.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { readerActor } from "./access.ts";
import type { Reader } from "./access.ts";
import { allowedFor } from "./authorize.ts";
import { sectionCountOf, versionText } from "./documents.ts";
import { portsOf } from "./ports.ts";

// The Brain's memory commands (GRA-297; the Brain design's "Brain SDK and
// API" and "Memory model"): `remember`, `receipts.get`, `memories.get`
// and `memories.list`, over Knowledge's database, the Brain's store.
//
// A remember is retry-safe. Its key is keyed to the deployment and scoped
// to the caller and the operation, so another caller's same key is
// another command. The same key with the same request answers the
// recorded receipt while it is kept; with another request, it is
// `brain.idempotency_conflict`. The record, its receipt and its indexing
// intent (`indexing_state: pending`) commit in one batch on the one
// database, so a lost reply never leaves a record without its receipt.
//
// The Brain is content-agnostic: what a person asks it to remember is
// stored as they said it. A remembered record is `proposed`, never an
// accepted fact.
//
// A person's records and receipts are personal data: a personal purge
// (purge.ts) deletes them with the rest (`forgetPerson`), and the clock
// deletes receipts past their retention (`sweepBrainReceipts`).
//
// This slice serves a signed-in person, for their own `person`-scoped
// records. An App or agent can't remember yet: writing will be a
// permission action of its own, with its own consent, so a read grant
// (`brain`) never gains writes. Their calls are refused as `brain.denied`.

/**
 * How long a receipt, and so its key, is kept: a retry within it answers
 * the recorded result, and after it the key may be used again. The
 * Brain's retention defaults (GRA-327) may change it.
 */
export const receiptRetentionMs = 24 * 60 * 60 * 1000;

/** Most records one page of `memories.list` holds when it doesn't say. */
const defaultPage = 20;

/**
 * Most remembers one person makes within `rememberWindowMs`, refused or
 * not, past which another is `brain.budget_exceeded`: far above what a
 * person or their chats ask for, and a bound on what a runaway caller
 * can fill the store with. Two landing at once may each pass the last
 * place, so the bound is this or a few over (as statistics.ts's).
 */
export const rememberPerWindow = 500;

/** The window `rememberPerWindow` counts over: a receipt's retention. */
const rememberWindowMs = 24 * 60 * 60 * 1000;

/** Expired receipts one statement of a sweep deletes. */
export const receiptsSweptPerStatement = 1000;

/** How long one sweep goes on deleting, in milliseconds. */
const sweepBudgetMs = 5000;

/** The person a command acts for, or a refusal for anyone else, yet. */
const personOf = (reader: Reader): string => {
  if (reader.type !== "person") {
    throw brainErrors.create("brain.denied");
  }
  return reader.person.userId;
};

/** Who may read a receipt back, and whose keys are whose. */
const callerKey = (userId: string): string => canonicalJson(["person", userId]);

/** `parts` keyed to this deployment: never computable from them alone. */
const keyed = async (
  env: Env,
  purpose: string,
  parts: Json
): Promise<string> => {
  const key = await derivedHmacKey(env, purpose, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalJson(parts))
  );
  return toHex(new Uint8Array(mac));
};

const refsSchema = z.array(brainSourceRefSchema);

/**
 * The statements that delete `userId`'s records and receipts, for a
 * personal purge's batch (purge.ts), which records the audit event.
 */
export const forgetPerson = (db: DrizzleD1Database, userId: string) =>
  [
    db.delete(brainMemories).where(eq(brainMemories.ownerId, userId)),
    db.delete(brainReceipts).where(eq(brainReceipts.caller, callerKey(userId))),
  ] as const;

/** How many records and receipts `forgetPerson` deletes. */
export const personCounts = async (
  db: DrizzleD1Database,
  userId: string
): Promise<{ memories: number; receipts: number }> => {
  const [[memories], [receipts]] = await Promise.all([
    db
      .select({ count: count() })
      .from(brainMemories)
      .where(eq(brainMemories.ownerId, userId)),
    db
      .select({ count: count() })
      .from(brainReceipts)
      .where(eq(brainReceipts.caller, callerKey(userId))),
  ]);
  return { memories: memories?.count ?? 0, receipts: receipts?.count ?? 0 };
};

/**
 * Deletes the receipts past their retention as of `now`, by
 * `brain_receipts_retention_idx`, `receiptsSweptPerStatement` at a time,
 * until none are left or `budgetMs` has passed: what one tick leaves,
 * the next deletes. Their keys are forgotten, and `receipts.get` answers
 * them as never made. The clock runs it (src/clock.ts).
 */
export const sweepBrainReceipts = async (
  env: Env,
  now: Date,
  budgetMs = sweepBudgetMs
): Promise<void> => {
  const ends = Date.now() + budgetMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded delete after another
    const { meta } = await env.KNOWLEDGE.prepare(
      `DELETE FROM brain_receipts WHERE rowid IN (
         SELECT rowid FROM brain_receipts WHERE retention_until <= ? LIMIT ?
       )`
    )
      .bind(now.getTime(), receiptsSweptPerStatement)
      .run();
    if (meta.changes < receiptsSweptPerStatement || Date.now() >= ends) {
      return;
    }
  }
};

/** Whether a receipt kept until `retentionUntil` has expired by `now`. */
const expired = (retentionUntil: Date, now: Date): boolean =>
  retentionUntil <= now;

/** A receipt row as the contract has it. */
const receiptOf = (row: typeof brainReceipts.$inferSelect): CommandReceipt => ({
  id: brainReceiptIdSchema.parse(row.id),
  contractVersion: brainContractVersion,
  operation: row.operation,
  requestHash: row.requestHash,
  status: row.status,
  resourceRefs: refsSchema.parse(JSON.parse(row.resourceRefs)),
  indexingState: row.indexingState,
  retentionUntil: row.retentionUntil.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

/** A memory row as the contract has it. */
const recordOf = (row: typeof brainMemories.$inferSelect): MemoryRecord => ({
  id: memoryIdSchema.parse(row.id),
  revision: row.revision,
  kind: row.kind,
  scope: row.scope,
  statement: row.statement,
  sourceRefs: refsSchema.parse(JSON.parse(row.sourceRefs)),
  state: row.state,
  validFrom: null,
  validTo: null,
  recordedAt: row.recordedAt.toISOString(),
  reviewAt: null,
});

/**
 * Refuses, as `brain.not_found`, a reference `reader` can't stand behind:
 * a document version of a collection they may not read (or that doesn't
 * exist, which answers the same), or a memory revision that isn't theirs.
 * A memory never cites what its author couldn't read.
 */
const requireCitable = async (
  env: Env,
  reader: Reader,
  ownerId: string,
  refs: readonly BrainSourceRef[]
): Promise<void> => {
  if (refs.length === 0) {
    return;
  }
  const db = drizzle(env.KNOWLEDGE);
  const documentRefs = refs.filter((ref) => ref.kind === "document");
  const memoryRefs = refs.filter((ref) => ref.kind === "memory");
  const allowed = await allowedFor(portsOf(env), reader);
  const citable = await Promise.all([
    ...documentRefs.map(async (ref) => {
      const row = await db
        .select({ path: documents.path })
        .from(versions)
        .innerJoin(documents, eq(documents.id, versions.documentId))
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .where(
          and(
            eq(versions.documentId, ref.documentId),
            eq(versions.number, ref.version),
            eq(documents.collectionId, ref.collectionId),
            allowed.documents()
          )
        )
        .get();
      if (row === undefined || ref.section === undefined) {
        return row !== undefined;
      }
      // Only the current version's sections are stored, so the section is
      // looked for in the cited version's own text, as its save split it.
      const text = await versionText(env, db, ref.documentId, ref.version);
      const sections =
        text === undefined ? undefined : sectionCountOf(row.path, text);
      return sections !== undefined && ref.section < sections;
    }),
    ...memoryRefs.map(async (ref) => {
      const row = await db
        .select({ id: brainMemories.id })
        .from(brainMemories)
        .where(
          and(
            eq(brainMemories.id, ref.memoryId),
            eq(brainMemories.ownerId, ownerId),
            eq(brainMemories.revision, ref.revision)
          )
        )
        .get();
      return row !== undefined;
    }),
  ]);
  if (citable.includes(false)) {
    throw brainErrors.create("brain.not_found");
  }
};

/** The receipt kept for `keyHash`, if it is still kept. */
const keptReceipt = async (
  env: Env,
  keyHash: string,
  now: Date
): Promise<typeof brainReceipts.$inferSelect | undefined> => {
  const db = drizzle(env.KNOWLEDGE);
  const row = await db
    .select()
    .from(brainReceipts)
    .where(eq(brainReceipts.keyHash, keyHash))
    .get();
  if (row === undefined || !expired(row.retentionUntil, now)) {
    return row;
  }
  // Past its retention the key is forgotten: it may name a new command.
  // The same boundary as `expired`, so the row it calls expired goes.
  await db
    .delete(brainReceipts)
    .where(
      and(eq(brainReceipts.id, row.id), lte(brainReceipts.retentionUntil, now))
    );
  return undefined;
};

/**
 * Refuses, as `brain.budget_exceeded`, a remember by `caller` past
 * `rememberPerWindow` in the window up to `now`: early, before the
 * citations are checked. The batch checks again as it writes
 * (`withinBound`), so calls in flight together can't pass it.
 */
const requireWithinBound = async (
  env: Env,
  caller: string,
  now: Date
): Promise<void> => {
  const [recent] = await drizzle(env.KNOWLEDGE)
    .select({ count: count() })
    .from(brainReceipts)
    .where(
      and(
        eq(brainReceipts.caller, caller),
        gt(brainReceipts.createdAt, new Date(now.getTime() - rememberWindowMs))
      )
    );
  if ((recent?.count ?? 0) >= rememberPerWindow) {
    throw brainErrors.create("brain.budget_exceeded");
  }
};

/**
 * That `caller` has made fewer than `rememberPerWindow` remembers in the
 * window up to `now`, as SQL: the receipt's insert is conditional on it,
 * in the statement that writes it.
 */
const withinBound = (caller: string, now: Date) =>
  sql`(SELECT count(*) FROM ${brainReceipts} WHERE ${brainReceipts.caller} = ${caller} AND ${brainReceipts.createdAt} > ${now.getTime() - rememberWindowMs}) < ${rememberPerWindow}`;

/** That the batch wrote the receipt `id`, as SQL. */
const receiptStored = (id: string) =>
  sql`EXISTS (SELECT 1 FROM ${brainReceipts} WHERE ${brainReceipts.id} = ${id})`;

/** `kept`'s answer to a retry with `requestHash`: it, or a conflict. */
const replayed = (
  kept: typeof brainReceipts.$inferSelect,
  requestHash: string
): CommandReceipt => {
  if (kept.requestHash !== requestHash) {
    throw brainErrors.create("brain.idempotency_conflict");
  }
  return receiptOf(kept);
};

/**
 * Remembers `input` for `reader`, retry-safe under `options`' key: the
 * command's receipt. Admitted text is stored as a `proposed` record of
 * the person's own, with its receipt and its indexing intent in one
 * batch; refused text keeps only its receipt. Refusals are the Brain's
 * stable codes.
 */
export const remember = async (
  env: Env,
  reader: Reader,
  input: unknown,
  options: unknown
): Promise<CommandReceipt> => {
  const ownerId = personOf(reader);
  const request = brainErrors.parse(
    "brain.invalid",
    rememberInputSchema,
    input
  );
  const { idempotencyKey, expectedRevision } = brainErrors.parse(
    "brain.invalid",
    commandOptionsSchema,
    options
  );
  // A remember makes a new record: it has no revision to be made against.
  if (expectedRevision !== undefined) {
    throw brainErrors.create("brain.invalid");
  }
  const caller = callerKey(ownerId);
  const keyHash = await keyed(env, "grasp-os brain command key", [
    caller,
    "remember",
    brainContractVersion,
    idempotencyKey,
  ]);
  const sourceRefs = request.sourceRefs ?? [];
  // The caller too, so a request's hash says nothing across people: the
  // same text remembered by two people hashes apart.
  const requestHash = await keyed(env, "grasp-os brain request", [
    caller,
    "remember",
    brainContractVersion,
    request.kind,
    request.text,
    sourceRefs,
  ]);
  const now = new Date();
  const kept = await keptReceipt(env, keyHash, now);
  if (kept !== undefined) {
    return replayed(kept, requestHash);
  }
  // After the replay, so a retry of a kept command still answers.
  await requireWithinBound(env, caller, now);
  await requireCitable(env, reader, ownerId, sourceRefs);
  const db = drizzle(env.KNOWLEDGE);
  const receiptId = crypto.randomUUID();
  const memoryId = crypto.randomUUID();
  const receipt = {
    id: receiptId,
    keyHash,
    caller,
    operation: "remember" as const,
    requestHash,
    status: "committed" as const,
    indexingState: "pending" as const,
    resourceRefs: JSON.stringify([{ kind: "memory", memoryId, revision: 1 }]),
    createdAt: now,
    retentionUntil: new Date(now.getTime() + receiptRetentionMs),
  };
  // The receipt, if the caller is within the bound as it is written; the
  // record and the event only if the receipt was: one batch, so never one
  // without the others, and calls in flight together can't pass the bound.
  let stored: { id: string }[];
  try {
    [stored] = await auditedBatch(env, db, [
      db
        .insert(brainReceipts)
        .select(
          sql`SELECT ${receipt.id}, ${receipt.keyHash}, ${receipt.caller}, ${receipt.operation}, ${receipt.requestHash}, ${receipt.status}, ${receipt.indexingState}, ${receipt.resourceRefs}, ${receipt.createdAt.getTime()}, ${receipt.retentionUntil.getTime()} WHERE ${withinBound(caller, now)}`
        )
        .returning({ id: brainReceipts.id }),
      db
        .insert(brainMemories)
        .select(
          sql`SELECT ${memoryId}, 1, 'person', ${ownerId}, ${request.kind}, ${request.text}, ${JSON.stringify(sourceRefs)}, 'proposed', 'pending', ${now.getTime()}, ${now.getTime()} WHERE ${receiptStored(receiptId)}`
        ),
      outboxedWhere(
        db,
        {
          actor: readerActor(reader),
          action: "knowledge.memory.remember",
          target: { type: "memory", id: memoryId },
          provenance: sourceRefs
            .map((ref) =>
              ref.kind === "document" ? ref.documentId : ref.memoryId
            )
            .slice(0, 20),
          detail: { kind: request.kind, receipt: receiptId },
        },
        receiptStored(receiptId)
      ),
    ]);
  } catch (error) {
    // Another call with the same key committed first: answer as its retry.
    const raced = await keptReceipt(env, keyHash, now);
    if (raced !== undefined) {
      return replayed(raced, requestHash);
    }
    throw error;
  }
  if (stored.length === 0) {
    throw brainErrors.create("brain.budget_exceeded");
  }
  return receiptOf({ ...receipt });
};

/**
 * A command's receipt, recovered after a lost reply: only the caller that
 * made it reads it back, and anyone else's, or one never made, is
 * `brain.not_found` alike. One past its retention is
 * `brain.receipt_expired` until the clock sweeps it, and then one never
 * made.
 */
export const receiptsGet = async (
  env: Env,
  reader: Reader,
  input: unknown
): Promise<CommandReceipt> => {
  const ownerId = personOf(reader);
  const { receiptId } = brainErrors.parse(
    "brain.invalid",
    receiptsGetInputSchema,
    input
  );
  const row = await drizzle(env.KNOWLEDGE)
    .select()
    .from(brainReceipts)
    .where(
      and(
        eq(brainReceipts.id, receiptId),
        eq(brainReceipts.caller, callerKey(ownerId))
      )
    )
    .get();
  if (row === undefined) {
    throw brainErrors.create("brain.not_found");
  }
  if (expired(row.retentionUntil, new Date())) {
    throw brainErrors.create("brain.receipt_expired");
  }
  return receiptOf(row);
};

/**
 * One of the person's own records; anyone else's is `brain.not_found`.
 */
export const memoriesGet = async (
  env: Env,
  reader: Reader,
  input: unknown
): Promise<MemoryRecord> => {
  const ownerId = personOf(reader);
  const { memoryId } = brainErrors.parse(
    "brain.invalid",
    memoriesGetInputSchema,
    input
  );
  const row = await drizzle(env.KNOWLEDGE)
    .select()
    .from(brainMemories)
    .where(
      and(eq(brainMemories.id, memoryId), eq(brainMemories.ownerId, ownerId))
    )
    .get();
  if (row === undefined) {
    throw brainErrors.create("brain.not_found");
  }
  return recordOf(row);
};

/** Where a page ends: its last record's time and ID, and their seal. */
const cursorSchema = z.tuple([z.int().min(0), z.string().min(1), z.string()]);

/** Whose walk a cursor is, and of which kind of record (or all). */
interface CursorScope {
  caller: string;
  kind: string | undefined;
}

/**
 * The seal of a cursor's position for `scope`: a cursor is opaque, and
 * only the person it was written for walks on from it, through the same
 * kind of record.
 */
const cursorSeal = async (
  env: Env,
  { caller, kind }: CursorScope,
  recordedAt: number,
  id: string
): Promise<string> =>
  await keyed(env, "grasp-os brain list cursor", [
    caller,
    kind ?? null,
    recordedAt,
    id,
  ]);

/** A cursor for `scope` after the record `row`. */
const writeCursor = async (
  env: Env,
  scope: CursorScope,
  row: typeof brainMemories.$inferSelect
): Promise<string> => {
  const recordedAt = row.recordedAt.getTime();
  const seal = await cursorSeal(env, scope, recordedAt, row.id);
  return btoa(JSON.stringify([recordedAt, row.id, seal]));
};

/**
 * `cursor` read back, or a refusal for one core didn't write for
 * `scope`.
 */
const readCursor = async (
  env: Env,
  scope: CursorScope,
  cursor: string
): Promise<{ recordedAt: Date; id: string }> => {
  let parsed: z.output<typeof cursorSchema>;
  try {
    parsed = cursorSchema.parse(JSON.parse(atob(cursor)));
  } catch {
    throw brainErrors.create("brain.invalid");
  }
  const [recordedAt, id, seal] = parsed;
  if (seal !== (await cursorSeal(env, scope, recordedAt, id))) {
    throw brainErrors.create("brain.invalid");
  }
  return { recordedAt: new Date(recordedAt), id };
};

/**
 * The person's own records, newest first, a bounded page at a time, of
 * one kind if asked: the next page starts after `cursor`.
 */
export const memoriesList = async (
  env: Env,
  reader: Reader,
  input: unknown = {}
): Promise<MemoryPage> => {
  const ownerId = personOf(reader);
  const caller = callerKey(ownerId);
  const { kind, limit, cursor } = brainErrors.parse(
    "brain.invalid",
    memoriesListInputSchema,
    input
  );
  const size = limit ?? defaultPage;
  const scope = { caller, kind };
  const after =
    cursor === undefined ? undefined : await readCursor(env, scope, cursor);
  const rows = await drizzle(env.KNOWLEDGE)
    .select()
    .from(brainMemories)
    .where(
      and(
        eq(brainMemories.ownerId, ownerId),
        kind === undefined ? undefined : eq(brainMemories.kind, kind),
        after === undefined
          ? undefined
          : or(
              lt(brainMemories.recordedAt, after.recordedAt),
              and(
                eq(brainMemories.recordedAt, after.recordedAt),
                lt(brainMemories.id, after.id)
              )
            )
      )
    )
    .orderBy(desc(brainMemories.recordedAt), desc(brainMemories.id))
    .limit(size + 1);
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    records: page.map(recordOf),
    cursor:
      rows.length > size && last !== undefined
        ? await writeCursor(env, scope, last)
        : null,
  };
};
