import { and, count, desc, eq, gt, lt, lte, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedWhere } from "./audit.ts";
import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import {
  brainContractVersion,
  brainErrors,
  brainSourceRefSchema,
  commandOptionsSchema,
  memoriesGetInputSchema,
  memoriesListInputSchema,
  receiptsGetInputSchema,
  rememberInputSchema,
} from "./contract.ts";
import type {
  BrainSourceRef,
  CommandReceipt,
  MemoryPage,
  MemoryRecord,
} from "./contract.ts";
import {
  brainMemories,
  brainReceipts,
  collections,
  documents,
  versions,
} from "./db/schema.ts";
import { sectionCountOf, versionText } from "./documents.ts";
import { toHex } from "./encoding.ts";
import { brainReceiptIdSchema, memoryIdSchema } from "./ids.ts";
import { canonicalJson } from "./json.ts";
import type { Json } from "./json.ts";

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
// (purge.ts) deletes them with the rest (`forgetPerson`), a content purge
// redacts or deletes every record holding its terms, whoever's
// (`eraseStatements`), and the clock deletes receipts past their
// retention (`sweepBrainReceipts`).
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

/** Who may read a receipt back, and whose keys are whose. */
const callerKey = (userId: string): string => canonicalJson(["person", userId]);

/** `parts` keyed to this deployment: never computable from them alone. */
const keyed = async <C>(
  brain: Brain<C>,
  purpose: string,
  parts: Json
): Promise<string> => {
  const key = await brain.ports.keys.hmac(purpose, ["sign"]);
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

/** Records one page of a content purge's scan of every record reads. */
const recordsPerScanPage = 200;

/**
 * Records one batch of a content purge rewrites or deletes: each is an
 * audit event and a write, so a batch stays well within D1's statements
 * per invocation.
 */
const recordsPerEraseBatch = 50;

interface StatementRow {
  id: string;
  revision: number;
  statement: string;
}

/**
 * Hands `visit` every record's statement, a page at a time in ID order,
 * whoever's it is and whatever its scope: what a content purge reaches.
 */
const scanStatements = async (
  db: DrizzleD1Database,
  visit: (page: StatementRow[]) => void
): Promise<void> => {
  for (let after = ""; ;) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time, to bound memory
    const page = await db
      .select({
        id: brainMemories.id,
        revision: brainMemories.revision,
        statement: brainMemories.statement,
      })
      .from(brainMemories)
      .where(gt(brainMemories.id, after))
      .orderBy(brainMemories.id)
      .limit(recordsPerScanPage);
    visit(page);
    const last = page.at(-1);
    if (last === undefined || page.length < recordsPerScanPage) {
      return;
    }
    after = last.id;
  }
};

/**
 * How many records' statements `holds` is true of, everyone's: those a
 * content purge's terms are in, which it would erase (its plan) or failed
 * to (its check).
 */
export const countStatements = async <C>(
  { db }: Brain<C>,
  holds: (statement: string) => boolean
): Promise<number> => {
  let total = 0;
  await scanStatements(db, (page) => {
    total += page.filter(({ statement }) => holds(statement)).length;
  });
  return total;
};

/**
 * Erases what a content purge removes from every record's statement,
 * whoever's it is (GRA-1027): `erase` says, for each statement, what it
 * becomes (itself when it holds nothing to remove), or `null` when
 * nothing worth keeping is left, and the record is deleted. A redacted
 * record gets its next revision and is pending indexing again, so search,
 * when it holds records, indexes the redacted statement in place of the
 * old one. Each change is audited, with `purgeId`, never the text, in the
 * batch that makes it; a batch makes all of its changes or none.
 *
 * A write is conditional on the revision read, so a record changed since
 * (deleted by a personal purge, say) is left as it is, unrecorded. A
 * record remembered after its page was read isn't reached: the purge's
 * check counts it (`countStatements`), and running the purge again
 * erases it.
 *
 * Receipts stay: they hold no text (the request's hash is keyed to the
 * deployment), and a retry of the remember they answer must replay them
 * rather than store the statement again. Returns how many records it
 * redacted and deleted.
 */
export const eraseStatements = async <C>(
  brain: Brain<C>,
  actor: Json,
  purgeId: string,
  erase: (statement: string) => string | null
): Promise<{ redacted: number; deleted: number }> => {
  const { db } = brain;
  const changes: { id: string; revision: number; now: string | null }[] = [];
  await scanStatements(db, (page) => {
    for (const { id, revision, statement } of page) {
      const now = erase(statement);
      if (now !== statement) {
        changes.push({ id, revision, now });
      }
    }
  });
  const updatedAt = new Date();
  const write = ({ id, revision, now }: (typeof changes)[number]) => {
    const asRead = and(
      eq(brainMemories.id, id),
      eq(brainMemories.revision, revision)
    );
    const event = outboxedWhere(
      brain,
      {
        actor,
        action: "knowledge.memory.purged",
        target: { type: "memory", id },
        detail: {
          purgeId,
          change: now === null ? "deleted" : "redacted",
          revision,
        },
      },
      sql`EXISTS (SELECT 1 FROM ${brainMemories} WHERE ${asRead})`
    );
    return [
      // Before the write, on the same condition: recorded only if made.
      event,
      now === null
        ? db.delete(brainMemories).where(asRead)
        : db
            .update(brainMemories)
            .set({
              statement: now,
              revision: revision + 1,
              indexingState: "pending",
              updatedAt,
            })
            .where(asRead),
    ] as const;
  };
  for (let at = 0; at < changes.length; at += recordsPerEraseBatch) {
    const [first, ...rest] = changes
      .slice(at, at + recordsPerEraseBatch)
      .flatMap(write);
    if (first !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
      await auditedBatch(brain.ports, db, [first, ...rest]);
    }
  }
  const deleted = changes.filter(({ now }) => now === null).length;
  return { redacted: changes.length - deleted, deleted };
};

/**
 * Deletes the receipts past their retention as of `now`, by
 * `brain_receipts_retention_idx`, `receiptsSweptPerStatement` at a time,
 * until none are left or `budgetMs` has passed: what one tick leaves,
 * the next deletes. Their keys are forgotten, and `receipts.get` answers
 * them as never made. The clock runs it (src/clock.ts).
 */
export const sweepBrainReceipts = async <C>(
  brain: Brain<C>,
  now: Date,
  budgetMs = sweepBudgetMs
): Promise<void> => {
  const ends = Date.now() + budgetMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded delete after another
    const { meta } = await brain.db.run(
      sql`DELETE FROM brain_receipts WHERE rowid IN (
         SELECT rowid FROM brain_receipts WHERE retention_until <= ${now.getTime()} LIMIT ${receiptsSweptPerStatement}
       )`
    );
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
const requireCitable = async <C>(
  brain: Brain<C>,
  reader: C,
  ownerId: string,
  refs: readonly BrainSourceRef[]
): Promise<void> => {
  if (refs.length === 0) {
    return;
  }
  const { db } = brain;
  const documentRefs = refs.filter((ref) => ref.kind === "document");
  const memoryRefs = refs.filter((ref) => ref.kind === "memory");
  const allowed = await allowedFor(brain.ports, reader);
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
      const text = await versionText(brain, db, ref.documentId, ref.version);
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
const keptReceipt = async <C>(
  brain: Brain<C>,
  keyHash: string,
  now: Date
): Promise<typeof brainReceipts.$inferSelect | undefined> => {
  const { db } = brain;
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
const requireWithinBound = async <C>(
  brain: Brain<C>,
  caller: string,
  now: Date
): Promise<void> => {
  const [recent] = await brain.db
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
export const remember = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown,
  options: unknown
): Promise<CommandReceipt> => {
  const ownerId = brain.ports.ownerOf(reader);
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
  const keyHash = await keyed(brain, "grasp-os brain command key", [
    caller,
    "remember",
    brainContractVersion,
    idempotencyKey,
  ]);
  const sourceRefs = request.sourceRefs ?? [];
  // The caller too, so a request's hash says nothing across people: the
  // same text remembered by two people hashes apart.
  const requestHash = await keyed(brain, "grasp-os brain request", [
    caller,
    "remember",
    brainContractVersion,
    request.kind,
    request.text,
    sourceRefs,
  ]);
  const now = brain.ports.clock();
  const kept = await keptReceipt(brain, keyHash, now);
  if (kept !== undefined) {
    return replayed(kept, requestHash);
  }
  // After the replay, so a retry of a kept command still answers.
  await requireWithinBound(brain, caller, now);
  await requireCitable(brain, reader, ownerId, sourceRefs);
  const { db } = brain;
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
    [stored] = await auditedBatch(brain.ports, db, [
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
        brain,
        {
          actor: brain.ports.actorOf(reader),
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
    const raced = await keptReceipt(brain, keyHash, now);
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
export const receiptsGet = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<CommandReceipt> => {
  const ownerId = brain.ports.ownerOf(reader);
  const { receiptId } = brainErrors.parse(
    "brain.invalid",
    receiptsGetInputSchema,
    input
  );
  const row = await brain.db
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
  if (expired(row.retentionUntil, brain.ports.clock())) {
    throw brainErrors.create("brain.receipt_expired");
  }
  return receiptOf(row);
};

/**
 * One of the person's own records; anyone else's is `brain.not_found`.
 */
export const memoriesGet = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<MemoryRecord> => {
  const ownerId = brain.ports.ownerOf(reader);
  const { memoryId } = brainErrors.parse(
    "brain.invalid",
    memoriesGetInputSchema,
    input
  );
  const row = await brain.db
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
const cursorSeal = async <C>(
  brain: Brain<C>,
  { caller, kind }: CursorScope,
  recordedAt: number,
  id: string
): Promise<string> =>
  await keyed(brain, "grasp-os brain list cursor", [
    caller,
    kind ?? null,
    recordedAt,
    id,
  ]);

/** A cursor for `scope` after the record `row`. */
const writeCursor = async <C>(
  brain: Brain<C>,
  scope: CursorScope,
  row: typeof brainMemories.$inferSelect
): Promise<string> => {
  const recordedAt = row.recordedAt.getTime();
  const seal = await cursorSeal(brain, scope, recordedAt, row.id);
  return btoa(JSON.stringify([recordedAt, row.id, seal]));
};

/**
 * `cursor` read back, or a refusal for one core didn't write for
 * `scope`.
 */
const readCursor = async <C>(
  brain: Brain<C>,
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
  if (seal !== (await cursorSeal(brain, scope, recordedAt, id))) {
    throw brainErrors.create("brain.invalid");
  }
  return { recordedAt: new Date(recordedAt), id };
};

/**
 * The person's own records, newest first, a bounded page at a time, of
 * one kind if asked: the next page starts after `cursor`.
 */
export const memoriesList = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown = {}
): Promise<MemoryPage> => {
  const ownerId = brain.ports.ownerOf(reader);
  const caller = callerKey(ownerId);
  const { kind, limit, cursor } = brainErrors.parse(
    "brain.invalid",
    memoriesListInputSchema,
    input
  );
  const size = limit ?? defaultPage;
  const scope = { caller, kind };
  const after =
    cursor === undefined ? undefined : await readCursor(brain, scope, cursor);
  const rows = await brain.db
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
        ? await writeCursor(brain, scope, last)
        : null,
  };
};
