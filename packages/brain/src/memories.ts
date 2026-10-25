import { and, count, desc, eq, gt, lt, lte, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedWhere } from "./audit.ts";
import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import {
  brainContractVersion,
  brainErrors,
  brainSourceRefSchema,
  changeOptionsSchema,
  commandOptionsSchema,
  memoriesGetInputSchema,
  memoriesListInputSchema,
  memoriesProposeChangeInputSchema,
  memoriesPublishInputSchema,
  memoriesRetireInputSchema,
  receiptsGetInputSchema,
  rememberInputSchema,
} from "./contract.ts";
import type {
  BrainSourceRef,
  CommandReceipt,
  MemoryPage,
  MemoryRecord,
} from "./contract.ts";
import { inList } from "./db/d1.ts";
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
import { forgetPersonOutcomes } from "./outcomes.ts";
import { asWord, termsOf } from "./search.ts";

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
 * The statements that delete `userId`'s records and receipts, and the
 * task outcomes recorded as their experience (outcomes.ts), for a
 * personal purge's batch (purge.ts), which records the audit event.
 */
export const forgetPerson = (
  db: DrizzleD1Database,
  userId: string,
  now: Date
) =>
  [
    db.delete(brainMemories).where(eq(brainMemories.ownerId, userId)),
    db.delete(brainReceipts).where(eq(brainReceipts.caller, callerKey(userId))),
    ...forgetPersonOutcomes(db, userId, now),
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
export const recordOf = (
  row: typeof brainMemories.$inferSelect
): MemoryRecord => ({
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
          sql`SELECT ${memoryId}, 1, 'person', ${ownerId}, ${request.kind}, ${request.text}, ${JSON.stringify(sourceRefs)}, 'proposed', 'pending', ${now.getTime()}, ${now.getTime()}, ${ownerId} WHERE ${receiptStored(receiptId)}`
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
 * Who a read of memory serves (GRA-298), as the host compiles it from the
 * requester, the context and its output audience: the scopes it may read,
 * each by key. The Brain applies it as given and widens nothing: a person's
 * records only for the owners named, a team's only for the teams named,
 * the company's only when `company` holds, a session's only for the
 * sessions named.
 */
export interface MemoryAudience {
  owners: readonly string[];
  teams: readonly string[];
  company: boolean;
  sessions: readonly string[];
}

/**
 * What `audience` may read of `brain_memories`, as a condition: the
 * accepted records of its scopes, and an owner's own proposed records,
 * which they wrote themselves. Retired records never. Undefined for an
 * audience that reads none.
 */
export const audienceScope = (audience: MemoryAudience): SQL | undefined => {
  const scopes = [
    audience.owners.length === 0
      ? undefined
      : and(
          eq(brainMemories.scope, "person"),
          inList(brainMemories.scopeId, audience.owners)
        ),
    audience.teams.length === 0
      ? undefined
      : and(
          eq(brainMemories.scope, "team"),
          inList(brainMemories.scopeId, audience.teams),
          eq(brainMemories.state, "accepted")
        ),
    audience.company
      ? and(
          eq(brainMemories.scope, "company"),
          eq(brainMemories.state, "accepted")
        )
      : undefined,
    audience.sessions.length === 0
      ? undefined
      : and(
          eq(brainMemories.scope, "session"),
          inList(brainMemories.scopeId, audience.sessions),
          eq(brainMemories.state, "accepted")
        ),
  ].filter((scope) => scope !== undefined);
  return scopes.length === 0
    ? undefined
    : and(or(...scopes), ne(brainMemories.state, "retired"));
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
  /** Whose records the list is of: a cursor for one never pages another. */
  among: "mine" | "shared";
}

/**
 * The seal of a cursor's position for `scope`: a cursor is opaque, and
 * only the person it was written for walks on from it, through the same
 * kind of record.
 */
const cursorSeal = async <C>(
  brain: Brain<C>,
  { caller, kind, among }: CursorScope,
  recordedAt: number,
  id: string
): Promise<string> =>
  await keyed(brain, "grasp-os brain list cursor", [
    caller,
    kind ?? null,
    among,
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

/** Most rows one shared listing reads to fill its page; past it, it ends. */
const sharedScanMax = 500;

type MemoryRow = typeof brainMemories.$inferSelect;

/** Up to `most` rows `where` admits after `after`, newest first. */
const rowsAfter = async <C>(
  { db }: Brain<C>,
  where: SQL | undefined,
  after: { recordedAt: Date; id: string } | undefined,
  most: number
): Promise<MemoryRow[]> =>
  await db
    .select()
    .from(brainMemories)
    .where(
      and(
        where,
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
    .limit(most);

/**
 * Up to `size` + 1 of the shared rows `where` admits after `after` that
 * the host keeps for `people`, newest first: read a batch at a time until
 * that many are kept, the rows run out, or {@link sharedScanMax} were read.
 * A row the host drops is never the page's, nor where its cursor points.
 */
const keptRowsAfter = async <C>(
  brain: Brain<C>,
  reader: C,
  people: readonly string[],
  where: SQL | undefined,
  after: { recordedAt: Date; id: string } | undefined,
  size: number
): Promise<MemoryRow[]> => {
  const kept: MemoryRow[] = [];
  let position = after;
  let scanned = 0;
  while (kept.length <= size && scanned < sharedScanMax) {
    const wanted = Math.min(size + 1, sharedScanMax - scanned);
    // oxlint-disable-next-line no-await-in-loop -- each batch starts where the last ended
    const batch = await rowsAfter(brain, where, position, wanted);
    scanned += batch.length;
    // oxlint-disable-next-line no-await-in-loop -- as above
    const checked = await brain.ports.memories.keep(
      reader,
      people,
      batch.map((row) => ({ ...recordOf(row), ownerId: row.ownerId }))
    );
    const ids = new Set<string>(checked.map(({ id }) => id));
    kept.push(...batch.filter((row) => ids.has(row.id)));
    const last = batch.at(-1);
    if (last === undefined || batch.length < wanted) {
      break;
    }
    position = { recordedAt: last.recordedAt, id: last.id };
  }
  return kept.slice(0, size + 1);
};

/**
 * The caller's own records, or (`among: "shared"`) others' shared records
 * their memory audience reads now, newest first, a page at a time. A
 * shared page holds only records the host keeps, and its cursor points at
 * the last of them, a record the caller was just shown: never at one the
 * host dropped. A page has a cursor only when more kept records follow,
 * so a short page never says hidden ones exist; a listing that reads
 * {@link sharedScanMax} rows without filling its page ends there.
 */
export const memoriesList = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown = {}
): Promise<MemoryPage> => {
  const ownerId = brain.ports.ownerOf(reader);
  const caller = callerKey(ownerId);
  const { kind, limit, cursor, among } = brainErrors.parse(
    "brain.invalid",
    memoriesListInputSchema,
    input
  );
  const size = limit ?? defaultPage;
  const scope = { caller, kind, among: among ?? "mine" };
  const after =
    cursor === undefined ? undefined : await readCursor(brain, scope, cursor);
  const ofKind = kind === undefined ? undefined : eq(brainMemories.kind, kind);
  let rows: MemoryRow[];
  if (among === "shared") {
    // Others' shared records: those the caller's memory audience reads
    // now, as the host compiles it, re-checked by the host before shown.
    const { audience, people } = await brain.ports.memories.audienceOf(reader);
    const shared = audienceScope(audience);
    rows =
      shared === undefined
        ? []
        : await keptRowsAfter(
            brain,
            reader,
            people,
            and(shared, ne(brainMemories.ownerId, ownerId), ofKind),
            after,
            size
          );
  } else {
    rows = await rowsAfter(
      brain,
      and(eq(brainMemories.ownerId, ownerId), ofKind),
      after,
      size + 1
    );
  }
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    // What another's record rests on is shown in its lineage, as far as
    // the reader may see it (memory-lineage.ts), never listed here.
    records: page.map((row) =>
      among === "shared" ? { ...recordOf(row), sourceRefs: [] } : recordOf(row)
    ),
    cursor:
      rows.length > size && last !== undefined
        ? await writeCursor(brain, scope, last)
        : null,
  };
};

/** Most records a turn's memory takes, and most characters of them. */
export const turnMemoryLimits = { records: 20, chars: 4000 } as const;

/**
 * The records `audience` may read, newest first, within `limits`: the
 * accepted ones of its scopes, and an owner's own proposed records, which
 * they wrote themselves. Retired records never. Each with whose it is, for
 * the host to say who wrote one that isn't the reader's.
 */
export const memoriesFor = async <C>(
  { db }: Brain<C>,
  audience: MemoryAudience,
  limits: { records: number; chars: number } = turnMemoryLimits
): Promise<(MemoryRecord & { ownerId: string })[]> => {
  const scope = audienceScope(audience);
  if (scope === undefined) {
    return [];
  }
  const rows = await db
    .select()
    .from(brainMemories)
    .where(scope)
    .orderBy(desc(brainMemories.recordedAt), desc(brainMemories.id))
    .limit(limits.records);
  const kept: (MemoryRecord & { ownerId: string })[] = [];
  let chars = 0;
  for (const row of rows) {
    // One too long for what is left is passed over; older ones may fit.
    if (chars + row.statement.length <= limits.chars) {
      chars += row.statement.length;
      kept.push({ ...recordOf(row), ownerId: row.ownerId });
    }
  }
  return kept;
};

/**
 * The records `audience` may read whose words match `query`'s, best
 * first, at most `limit` (GRA-298): any of its words, as a recall reads a
 * question (search.ts), in the statements' full-text index (migration
 * `0002_memory_search.sql`), ranked by how many of its words each holds,
 * newer first between equals.
 * The audience is part of the match, so a record outside it is never
 * ranked, counted or returned. Each with whose it is.
 */
export const searchMemories = async <C>(
  { db }: Brain<C>,
  audience: MemoryAudience,
  query: string,
  limit: number
): Promise<(MemoryRecord & { ownerId: string })[]> => {
  const scope = audienceScope(audience);
  const terms = termsOf(query);
  if (scope === undefined || terms.length === 0 || limit <= 0) {
    return [];
  }
  // Ranked by how many of the question's words a record holds, then
  // newest first: never by BM25, whose weights count the words of every
  // record in the index, other people's private ones too, so the order of
  // a reader's own records would tell them which words others' hold
  // (the GRA-298 security review). The index only matches.
  const hits = sql.join(
    terms.map(
      (term) => sql`(CASE WHEN brain_memory_words.rowid IN (
        SELECT rowid FROM brain_memory_words
        WHERE brain_memory_words MATCH ${asWord(term)}
      ) THEN 1 ELSE 0 END)`
    ),
    sql` + `
  );
  const matched = await db.all<{ id: string }>(sql`
    SELECT brain_memories.id AS id
    FROM brain_memory_words
    JOIN brain_memory_rows ON brain_memory_rows.id = brain_memory_words.rowid
    JOIN brain_memories ON brain_memories.id = brain_memory_rows.memory_id
    WHERE brain_memory_words MATCH ${terms.map(asWord).join(" OR ")}
      AND ${scope}
    ORDER BY ${hits} DESC, brain_memories.recorded_at DESC,
      brain_memories.id DESC
    LIMIT ${limit}
  `);
  const ids = matched.map(({ id }) => id);
  if (ids.length === 0) {
    return [];
  }
  // The records as they are now, under the same scope: one retired or
  // corrected since the match is left out.
  const rows = await db
    .select()
    .from(brainMemories)
    .where(and(inList(brainMemories.id, ids), scope));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined
      ? []
      : [{ ...recordOf(row), ownerId: row.ownerId }];
  });
};

/** The documents and memories `refs` name, as an event's provenance. */
const refIds = (refs: readonly BrainSourceRef[]): string[] =>
  refs
    .map((ref) => (ref.kind === "document" ? ref.documentId : ref.memoryId))
    .slice(0, 20);

/**
 * A command's keys: its key keyed to the deployment and scoped to `caller`
 * and `operation`, and its validated request's hash, `caller`'s too, so the
 * same request by two people hashes apart.
 */
const commandKeys = async <C>(
  brain: Brain<C>,
  caller: string,
  operation: CommandReceipt["operation"],
  idempotencyKey: string,
  request: Json
): Promise<{ keyHash: string; requestHash: string }> => ({
  keyHash: await keyed(brain, "grasp-os brain command key", [
    caller,
    operation,
    brainContractVersion,
    idempotencyKey,
  ]),
  requestHash: await keyed(brain, "grasp-os brain request", [
    caller,
    operation,
    brainContractVersion,
    request,
  ]),
});

/**
 * Stores `operation`'s receipt for `caller` with `writes`, in one batch:
 * the receipt only while the caller is within the bound and `condition`
 * holds, and each write only if the receipt was stored, so never one
 * without the others. A command a race committed first under the same key
 * answers as its retry. `undefined` when the receipt wasn't stored.
 */
const storeCommand = async <C>(
  brain: Brain<C>,
  command: {
    caller: string;
    operation: CommandReceipt["operation"];
    keyHash: string;
    requestHash: string;
    now: Date;
    resourceRefs: BrainSourceRef[];
    condition: SQL;
    /** Whether it counts toward the caller's bound: a retirement only removes. */
    bounded?: boolean;
    writes: (stored: SQL, receiptId: string) => readonly BatchItem<"sqlite">[];
  }
): Promise<CommandReceipt | undefined> => {
  const { db } = brain;
  const { caller, operation, keyHash, requestHash, now } = command;
  const receipt = {
    id: crypto.randomUUID(),
    keyHash,
    caller,
    operation,
    requestHash,
    status: "committed" as const,
    indexingState: "pending" as const,
    resourceRefs: JSON.stringify(command.resourceRefs),
    createdAt: now,
    retentionUntil: new Date(now.getTime() + receiptRetentionMs),
  };
  let stored: { id: string }[];
  try {
    [stored] = await auditedBatch(brain.ports, db, [
      db
        .insert(brainReceipts)
        .select(
          sql`SELECT ${receipt.id}, ${receipt.keyHash}, ${receipt.caller}, ${receipt.operation}, ${receipt.requestHash}, ${receipt.status}, ${receipt.indexingState}, ${receipt.resourceRefs}, ${receipt.createdAt.getTime()}, ${receipt.retentionUntil.getTime()} WHERE ${command.bounded === false ? sql`1` : withinBound(caller, now)} AND ${command.condition}`
        )
        .returning({ id: brainReceipts.id }),
      ...command.writes(receiptStored(receipt.id), receipt.id),
    ]);
  } catch (error) {
    const raced = await keptReceipt(brain, keyHash, now);
    if (raced !== undefined) {
      return replayed(raced, requestHash);
    }
    throw error;
  }
  if (stored.length === 0) {
    // A call with the same key committed first and changed what this one
    // was conditional on: answer as its retry.
    const raced = await keptReceipt(brain, keyHash, now);
    return raced === undefined ? undefined : replayed(raced, requestHash);
  }
  return receiptOf({ ...receipt });
};

/**
 * Publishes `input` into a shared scope for `reader` (GRA-298): a team's,
 * the company's or a chat's, only where the host lets them
 * (`mayPublish`), resting only on what that scope's whole audience may
 * read. Retry-safe under `options`' key, as a remember is. The record is
 * `accepted`: the publication is the authorized act.
 */
export const memoriesPublish = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown,
  options: unknown
): Promise<CommandReceipt> => {
  const ownerId = brain.ports.ownerOf(reader);
  const request = brainErrors.parse(
    "brain.invalid",
    memoriesPublishInputSchema,
    input
  );
  const { idempotencyKey, expectedRevision } = brainErrors.parse(
    "brain.invalid",
    commandOptionsSchema,
    options
  );
  if (expectedRevision !== undefined) {
    throw brainErrors.create("brain.invalid");
  }
  const caller = callerKey(ownerId);
  const sourceRefs = request.sourceRefs ?? [];
  const scopeId = request.scopeId ?? null;
  const { keyHash, requestHash } = await commandKeys(
    brain,
    caller,
    "memories.publish",
    idempotencyKey,
    [request.scope, scopeId, request.kind, request.text, sourceRefs]
  );
  const now = brain.ports.clock();
  const kept = await keptReceipt(brain, keyHash, now);
  if (kept !== undefined) {
    return replayed(kept, requestHash);
  }
  await requireWithinBound(brain, caller, now);
  await brain.ports.mayPublish(
    reader,
    { scope: request.scope, scopeId },
    sourceRefs
  );
  await requireCitable(brain, reader, ownerId, sourceRefs);
  const { db } = brain;
  const memoryId = crypto.randomUUID();
  const receipt = await storeCommand(brain, {
    caller,
    operation: "memories.publish",
    keyHash,
    requestHash,
    now,
    resourceRefs: [
      { kind: "memory", memoryId: memoryIdSchema.parse(memoryId), revision: 1 },
    ],
    condition: sql`1`,
    writes: (stored, receiptId) => [
      db
        .insert(brainMemories)
        .select(
          sql`SELECT ${memoryId}, 1, ${request.scope}, ${ownerId}, ${request.kind}, ${request.text}, ${JSON.stringify(sourceRefs)}, 'accepted', 'pending', ${now.getTime()}, ${now.getTime()}, ${scopeId} WHERE ${stored}`
        ),
      outboxedWhere(
        brain,
        {
          actor: brain.ports.actorOf(reader),
          action: "knowledge.memory.published",
          target: { type: "memory", id: memoryId },
          provenance: refIds(sourceRefs),
          detail: {
            kind: request.kind,
            scope: request.scope,
            scopeId,
            receipt: receiptId,
          },
        },
        stored
      ),
    ],
  });
  if (receipt === undefined) {
    throw brainErrors.create("brain.budget_exceeded");
  }
  return receipt;
};

/** That `memoryId` is `ownerId`'s own live personal record at `revision`, as SQL. */
const ownLive = (memoryId: string, ownerId: string, revision: number) =>
  and(
    eq(brainMemories.id, memoryId),
    eq(brainMemories.ownerId, ownerId),
    eq(brainMemories.scope, "person"),
    eq(brainMemories.revision, revision),
    ne(brainMemories.state, "retired")
  );

/**
 * Corrects one of `reader`'s own personal records (GRA-298): a new record
 * with the corrected statement, citing the one it corrects at the revision
 * it was made against, which is retired and kept, so its history stays.
 * Only the owner corrects their own; a stale revision is
 * `brain.revision_conflict`, never an overwrite. Retry-safe under
 * `options`' key. The correction is `accepted`: the owner's own word.
 */
export const memoriesProposeChange = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown,
  options: unknown
): Promise<CommandReceipt> => {
  const ownerId = brain.ports.ownerOf(reader);
  const request = brainErrors.parse(
    "brain.invalid",
    memoriesProposeChangeInputSchema,
    input
  );
  const { idempotencyKey, expectedRevision } = brainErrors.parse(
    "brain.invalid",
    changeOptionsSchema,
    options
  );
  const caller = callerKey(ownerId);
  const corrected = {
    kind: "memory" as const,
    memoryId: request.memoryId,
    revision: expectedRevision,
  };
  const sourceRefs = [...(request.sourceRefs ?? []), corrected];
  const { keyHash, requestHash } = await commandKeys(
    brain,
    caller,
    "memories.proposeChange",
    idempotencyKey,
    [request.memoryId, expectedRevision, request.statement, sourceRefs]
  );
  const now = brain.ports.clock();
  const kept = await keptReceipt(brain, keyHash, now);
  if (kept !== undefined) {
    return replayed(kept, requestHash);
  }
  const { db } = brain;
  const current = await db
    .select({
      revision: brainMemories.revision,
      state: brainMemories.state,
      kind: brainMemories.kind,
      scope: brainMemories.scope,
    })
    .from(brainMemories)
    .where(
      and(
        eq(brainMemories.id, request.memoryId),
        eq(brainMemories.ownerId, ownerId)
      )
    )
    .get();
  // Anyone else's, or one that doesn't exist, answers alike.
  if (current === undefined || current.scope !== "person") {
    throw brainErrors.create("brain.not_found");
  }
  if (current.revision !== expectedRevision || current.state === "retired") {
    throw brainErrors.create("brain.revision_conflict");
  }
  await requireWithinBound(brain, caller, now);
  await requireCitable(brain, reader, ownerId, request.sourceRefs ?? []);
  const memoryId = crypto.randomUUID();
  const live = ownLive(request.memoryId, ownerId, expectedRevision);
  const receipt = await storeCommand(brain, {
    caller,
    operation: "memories.proposeChange",
    keyHash,
    requestHash,
    now,
    resourceRefs: [
      { kind: "memory", memoryId: memoryIdSchema.parse(memoryId), revision: 1 },
    ],
    // Still the revision it was made against, and still live, as the
    // batch writes: a change that landed first wins, never overwritten.
    condition: sql`EXISTS (SELECT 1 FROM ${brainMemories} WHERE ${live})`,
    writes: (stored) => [
      db
        .insert(brainMemories)
        .select(
          sql`SELECT ${memoryId}, 1, 'person', ${ownerId}, ${current.kind}, ${request.statement}, ${JSON.stringify(sourceRefs)}, 'accepted', 'pending', ${now.getTime()}, ${now.getTime()}, ${ownerId} WHERE ${stored}`
        ),
      db
        .update(brainMemories)
        .set({ state: "retired", updatedAt: now })
        .where(and(live, stored)),
      outboxedWhere(
        brain,
        {
          actor: brain.ports.actorOf(reader),
          action: "knowledge.memory.corrected",
          target: { type: "memory", id: memoryId },
          provenance: refIds(sourceRefs),
          detail: { corrects: request.memoryId, revision: expectedRevision },
        },
        stored
      ),
    ],
  });
  if (receipt === undefined) {
    // Changed meanwhile, or past the bound: say which.
    const stillLive = await db
      .select({ id: brainMemories.id })
      .from(brainMemories)
      .where(live)
      .get();
    throw brainErrors.create(
      stillLive === undefined
        ? "brain.revision_conflict"
        : "brain.budget_exceeded"
    );
  }
  return receipt;
};

/**
 * Retires one of the shared records (GRA-298): a team's, the company's or
 * a chat's, by whoever the host lets (`mayRetire`: its publisher or an
 * admin). It is kept, retired, so its history stays, and never reaches a
 * prompt again. Retry-safe under `options`' key; a stale revision is
 * `brain.revision_conflict`.
 */
export const memoriesRetire = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown,
  options: unknown
): Promise<CommandReceipt> => {
  const callerId = brain.ports.ownerOf(reader);
  const { memoryId } = brainErrors.parse(
    "brain.invalid",
    memoriesRetireInputSchema,
    input
  );
  const { idempotencyKey, expectedRevision } = brainErrors.parse(
    "brain.invalid",
    changeOptionsSchema,
    options
  );
  const caller = callerKey(callerId);
  const { keyHash, requestHash } = await commandKeys(
    brain,
    caller,
    "memories.retire",
    idempotencyKey,
    [memoryId, expectedRevision]
  );
  const now = brain.ports.clock();
  const kept = await keptReceipt(brain, keyHash, now);
  if (kept !== undefined) {
    return replayed(kept, requestHash);
  }
  const { db } = brain;
  const row = await db
    .select()
    .from(brainMemories)
    .where(eq(brainMemories.id, memoryId))
    .get();
  if (row === undefined || row.scope === "person") {
    throw brainErrors.create("brain.not_found");
  }
  await brain.ports.mayRetire(reader, {
    scope: row.scope,
    scopeId: row.scopeId,
    ownerId: row.ownerId,
  });
  if (row.revision !== expectedRevision || row.state === "retired") {
    throw brainErrors.create("brain.revision_conflict");
  }
  const live = and(
    eq(brainMemories.id, memoryId),
    eq(brainMemories.revision, expectedRevision),
    ne(brainMemories.state, "retired")
  );
  const receipt = await storeCommand(brain, {
    caller,
    operation: "memories.retire",
    // Only removes: an admin cleaning up after many publishers isn't held
    // to one person's bound.
    bounded: false,
    keyHash,
    requestHash,
    now,
    resourceRefs: [
      {
        kind: "memory",
        memoryId: memoryIdSchema.parse(memoryId),
        revision: expectedRevision,
      },
    ],
    condition: sql`EXISTS (SELECT 1 FROM ${brainMemories} WHERE ${live})`,
    writes: (stored, receiptId) => [
      db
        .update(brainMemories)
        .set({ state: "retired", updatedAt: now })
        .where(and(live, stored)),
      outboxedWhere(
        brain,
        {
          actor: brain.ports.actorOf(reader),
          action: "knowledge.memory.retired",
          target: { type: "memory", id: memoryId },
          detail: {
            scope: row.scope,
            scopeId: row.scopeId,
            revision: expectedRevision,
            receipt: receiptId,
          },
        },
        stored
      ),
    ],
  });
  if (receipt === undefined) {
    const stillLive = await db
      .select({ id: brainMemories.id })
      .from(brainMemories)
      .where(live)
      .get();
    throw brainErrors.create(
      stillLive === undefined
        ? "brain.revision_conflict"
        : "brain.budget_exceeded"
    );
  }
  return receipt;
};
