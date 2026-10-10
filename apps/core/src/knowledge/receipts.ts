import { appErrors } from "@grasp-os/shared/apps";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId, CollectionId, PermissionId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { canonicalJson } from "@grasp-os/shared/json";
import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import {
  submissionErrors,
  submissionRetentionDays,
  submissionTombstoneDays,
} from "@grasp-os/shared/submissions";
import type { SubmissionIntent } from "@grasp-os/shared/submissions";
import { runOfStepKey } from "@grasp-os/shared/workflows";
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { inList } from "../db/d1.ts";
import {
  documents,
  submissionOutbox,
  submissionOutcomes,
  submissionReceipts,
} from "../db/knowledge/schema.ts";
import { liveRuns } from "../live-runs.ts";
import { outboxConsumers } from "../outbox-delivery.ts";
import type { OutboxConsumers } from "../outbox-delivery.ts";

// Receipts of record saves an App's code makes (knowledge/app-binding.ts),
// so a save retried after its answer was lost is made once, and an
// attempt that something newer took over, or that ran out of time, never
// commits. Threat model, and how each is closed:
//
// - A stale attempt commits after a newer one began: every attempt claims
//   the receipt first, which moves its fence on, and commits only with
//   the fence it claimed. The commit is a row whose foreign key is the
//   receipt at that fence (`submission_outcomes`), in the save's own
//   batch, so the database refuses it, and the whole save, once another
//   attempt claimed the receipt since. The fence orders claims, not
//   attempts: an older attempt that claims last holds it. That is
//   harmless, as every attempt under a receipt has the same input (other
//   input is refused before it claims), so whichever commits makes the
//   same change, and the others answer its outcome or write nothing.
// - A call is killed or times out after its save was prepared: nothing is
//   visible before the batch, and the batch checks the call's deadline by
//   the database's own clock (`on_time`), so a batch sent late commits
//   nothing, whatever the caller's clock or a check made just before it.
// - A save commits and its answer is lost, then is retried: the retry
//   finds the receipt's outcome and answers it, writing nothing. A batch
//   whose answer failed is read back the same way (`settled`).
// - A key is reused with other input: the receipt keeps its input's hash,
//   and other input under the key is `submission.key_conflict`, never
//   another input's outcome; a key whose receipt expired is
//   `submission.expired` for as long as its tombstone is kept.
// - Two saves edit the same record at once: each names the version it
//   expects (`ifVersion`); the next version's primary key lets one in and
//   fails the other with `knowledge.conflict`. A save that changes
//   nothing commits only its outcome, and only while the record is still
//   at that version (`current`), so a stale no-op is a conflict too.
// - A receipt expires under a commit, or a commit under the sweep: a
//   receipt is kept a retention from each claim and from its commit,
//   which set its `retain_until`, so a claim in flight is never swept; a
//   commit is refused all the same once the sweep expired its receipt
//   (`open`, defence in depth); the sweep's batch checks again that each
//   receipt is still due, and drops the outcomes only of those it expired.
// - A key crosses callers or resources: a receipt's ID hashes its whole
//   scope with the key (the person, the chain of Apps, the App's version
//   and method, the collection, its permission and the operation), so the
//   same key elsewhere is another receipt, and the caller is authorized
//   in full before a receipt is claimed, and again (its last check)
//   before an outcome is answered, so a key never lets anyone read an
//   outcome they couldn't make now. A last check that fails says nothing
//   about whether the save committed, and answers its own error.

const dayMs = 24 * 60 * 60 * 1000;

/** Most receipts one page of a sweep expires, or tombstones it deletes. */
const sweepPage = 100;

/** How long one sweep goes on taking pages, at most. */
const sweepBudgetMs = 20_000;

/** How much later a receipt kept for its live run is looked at again. */
const liveRunRecheckMs = dayMs;

/** Where a record save comes from, which its receipt is scoped to. */
export interface SubmissionScope {
  /** The person it is for. */
  principal: string;
  /** The Apps whose calls are under way, outermost first, the saving one last. */
  chain: readonly AppId[];
  appVersion: number;
  method: string;
  collectionId: CollectionId;
  permissionId: PermissionId;
}

/** A record save to keep a receipt of. */
export interface Submission {
  scope: SubmissionScope;
  /**
   * The caller's key: theirs, or for a workflow step, the step's key with
   * theirs (or the input's hash) under it.
   */
  key: Json;
  /** The run it is made in, for a workflow step's. */
  runId: string | null;
  /** When the call it is made in must end, in milliseconds since the epoch. */
  deadline: number;
  /** What it stages for its outbox (outbox.ts): a workflow's notification or start. */
  intents?: readonly SubmissionIntent[];
  /**
   * Who takes each kind of intent: this deployment's consumers unless
   * given. An intent no consumer takes is refused before anything is done.
   */
  consumers?: OutboxConsumers;
}

/** An attempt holding a receipt, for its commit. */
export interface Claim {
  id: string;
  fence: number;
  deadline: number;
  intents: readonly SubmissionIntent[];
}

/**
 * The key a save's receipt goes by: for a workflow step's caller, under
 * the step's key, the caller's own key or, without one, the input's
 * hash, so the step retried makes each of its saves once and two saves
 * of one step stay two; for anyone else, the caller's key, or a key of
 * its own, which no retry shares.
 */
export const submissionKey = (
  stepKey: string | undefined,
  key: string | undefined,
  inputHash: string
): { key: Json; runId: string | null } =>
  stepKey === undefined
    ? { key: ["call", key ?? crypto.randomUUID()], runId: null }
    : {
        key:
          key === undefined
            ? ["step", stepKey, "input", inputHash]
            : ["step", stepKey, "key", key],
        runId: runOfStepKey(stepKey) ?? null,
      };

/** The hash of a save's normalized input. */
export const inputHashOf = async (input: Json): Promise<string> =>
  await sha256Hex(canonicalJson(input));

const receiptIdOf = async ({ scope, key }: Submission): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      operation: "record.save",
      principal: scope.principal,
      chain: [...scope.chain],
      appVersion: scope.appVersion,
      method: scope.method,
      collectionId: scope.collectionId,
      permissionId: scope.permissionId,
      key,
    })
  );

/** The receipt `id`, with its outcome if it committed. */
const receiptOf = async (env: Env, id: string) =>
  await drizzle(env.KNOWLEDGE)
    .select({
      fence: submissionReceipts.fence,
      inputHash: submissionReceipts.inputHash,
      expiredAt: submissionReceipts.expiredAt,
      outcome: submissionOutcomes.outcome,
    })
    .from(submissionReceipts)
    .leftJoin(
      submissionOutcomes,
      eq(submissionOutcomes.receiptId, submissionReceipts.id)
    )
    .where(eq(submissionReceipts.id, id))
    .get();

// SAFETY: written by `commitOf` from a `DocumentSummary`, and never by
// anything else.
const summaryOf = (outcome: string): DocumentSummary =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  JSON.parse(outcome) as DocumentSummary;

/**
 * Claims the receipt of `submission`, whose input hashes to `inputHash`,
 * for a new attempt: a receipt made for it, or the fence of the one it
 * has moved on. The outcome instead when it committed already, which the
 * attempt answers without saving; `submission.key_conflict` when the key
 * was used for other input, `submission.expired` when its receipt
 * expired. Call it only once the caller is authorized in full.
 */
export const claim = async (
  env: Env,
  submission: Submission,
  inputHash: string,
  now = new Date()
): Promise<{ claim: Claim } | { outcome: DocumentSummary }> => {
  const consumers = submission.consumers ?? outboxConsumers;
  const intents = submission.intents ?? [];
  const id = await receiptIdOf(submission);
  // A save its key committed already is answered, whatever takes its
  // intents now: it stages nothing more.
  const committed = await receiptOf(env, id);
  if (
    committed !== undefined &&
    committed.expiredAt === null &&
    committed.inputHash === inputHash &&
    committed.outcome !== null
  ) {
    return { outcome: summaryOf(committed.outcome) };
  }
  // New work stages nothing that nothing would take: it would only be
  // settled away unread.
  if (intents.some(({ kind }) => consumers[kind] === undefined)) {
    throw submissionErrors.create("submission.intent_unsupported");
  }
  const db = drizzle(env.KNOWLEDGE);
  const retainUntil = new Date(now.getTime() + submissionRetentionDays * dayMs);
  // One statement: a new receipt, or the fence moved on, but only for the
  // same input, before it expired and before it committed. Either way it
  // is kept at least a retention from now, so the sweep never takes a
  // receipt whose claim is in flight (`open` stays as a backstop).
  const claimed = await db
    .insert(submissionReceipts)
    .values({
      id,
      operation: "record.save",
      principal: submission.scope.principal,
      appId: submission.scope.chain.at(-1) ?? "",
      collectionId: submission.scope.collectionId,
      runId: submission.runId,
      inputHash,
      fence: 1,
      createdAt: now,
      retainUntil,
    })
    .onConflictDoUpdate({
      target: submissionReceipts.id,
      set: {
        fence: sql`${submissionReceipts.fence} + 1`,
        retainUntil: sql`max(${submissionReceipts.retainUntil}, ${retainUntil.getTime()})`,
      },
      setWhere: and(
        eq(submissionReceipts.inputHash, inputHash),
        isNull(submissionReceipts.expiredAt),
        sql`NOT EXISTS (SELECT 1 FROM ${submissionOutcomes} WHERE ${submissionOutcomes.receiptId} = ${id})`
      ),
    })
    .returning({ fence: submissionReceipts.fence })
    .get();
  if (claimed !== undefined) {
    return {
      claim: {
        id,
        fence: claimed.fence,
        deadline: submission.deadline,
        intents,
      },
    };
  }
  const receipt = await receiptOf(env, id);
  if (receipt !== undefined && receipt.expiredAt !== null) {
    throw submissionErrors.create("submission.expired");
  }
  if (receipt === undefined || receipt.inputHash !== inputHash) {
    throw submissionErrors.create("submission.key_conflict");
  }
  if (receipt.outcome === null) {
    // Not expired, same input, not committed: the claim would have taken.
    throw new Error("A receipt neither claimable nor committed");
  }
  return { outcome: summaryOf(receipt.outcome) };
};

/**
 * The statements that commit `held`'s outcome, `outcome`, first in the
 * batch of its save: refused, with the batch, unless `held` still has the
 * receipt's fence, the receipt hasn't expired, and its deadline hasn't
 * passed by the database's clock, and, for a save that changes nothing
 * (`unchanged`), unless the document is still at the version the save
 * expected. The receipt is then kept `submissionRetentionDays` from the
 * commit, and the intents it staged go to its outbox (outbox.ts), each
 * under an ID made of the receipt's and its place.
 */
export const commitOf = (
  env: Env,
  held: Claim,
  outcome: DocumentSummary,
  unchanged?: { documentId: string; version: number }
): [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] => {
  const db = drizzle(env.KNOWLEDGE);
  const now = new Date();
  return [
    db.insert(submissionOutcomes).values({
      receiptId: held.id,
      fence: held.fence,
      open: sql`NOT EXISTS (SELECT 1 FROM ${submissionReceipts} WHERE ${submissionReceipts.id} = ${held.id} AND ${submissionReceipts.expiredAt} IS NOT NULL)`,
      // Milliseconds since the epoch, by the database's clock.
      onTime: sql`(unixepoch('subsec') * 1000) < ${held.deadline}`,
      current:
        unchanged === undefined
          ? true
          : sql`EXISTS (SELECT 1 FROM ${documents} WHERE ${documents.id} = ${unchanged.documentId} AND ${documents.currentVersion} = ${unchanged.version})`,
      outcome: JSON.stringify(outcome),
      committedAt: now,
    }),
    db
      .update(submissionReceipts)
      .set({
        retainUntil: new Date(now.getTime() + submissionRetentionDays * dayMs),
      })
      .where(
        and(
          eq(submissionReceipts.id, held.id),
          eq(submissionReceipts.fence, held.fence)
        )
      ),
    // One statement each: an intent can be large, and D1 binds at most
    // 100 parameters to one statement.
    ...held.intents.map((intent, position) =>
      db.insert(submissionOutbox).values({
        id: `${held.id}:${position}`,
        receiptId: held.id,
        position,
        kind: intent.kind,
        intent: JSON.stringify(intent),
        createdAt: now,
        nextAttemptAt: now,
      })
    ),
  ];
};

/**
 * A save's last check before its batch failed: what it threw, kept apart
 * from the batch's own failures, as it says nothing about whether the
 * save committed (`settled`).
 */
export class LastCheckFailedError extends Error {
  readonly refusal: unknown;

  constructor(refusal: unknown) {
    super("A save's last check failed");
    this.name = "LastCheckFailedError";
    this.refusal = refusal;
  }
}

/** `check`, with what it throws as a `LastCheckFailedError`. */
export const lastChecked =
  (check: () => Promise<void>): (() => Promise<void>) =>
  async () => {
    try {
      await check();
    } catch (error) {
      throw new LastCheckFailedError(error);
    }
  };

/** Whether D1 refused a write for the check `name`, however it was wrapped. */
const failedCheck = (error: unknown, name: string): boolean =>
  error instanceof Error &&
  ((error.message.includes("CHECK constraint failed") &&
    error.message.includes(name)) ||
    failedCheck(error.cause, name));

/**
 * What a save holding `held` answers after it failed with `error`: an
 * error of ours as it is (the save refused before or by its batch, such
 * as a caller no longer allowed, or `knowledge.conflict`); otherwise, the
 * batch having failed or its answer been lost, the outcome when the
 * receipt committed after all (its own batch, or another attempt of the
 * same input's);
 * `submission.superseded` when another attempt claimed the receipt since;
 * `app.caller_invalid` when its call's deadline passed before the batch,
 * as for any stub call past it; `knowledge.conflict` when a save that
 * changes nothing found the record moved on; `error` otherwise. An
 * outcome is answered only once `lastCheck`, the caller's last check,
 * passes again, as for a replay: whatever it throws is the answer
 * instead.
 */
export const settled = async (
  env: Env,
  held: Claim,
  error: unknown,
  lastCheck?: () => Promise<void>
): Promise<DocumentSummary> => {
  // Its last check failed: the caller may not be allowed any more, and
  // whatever the check threw is the answer.
  if (error instanceof LastCheckFailedError) {
    throw error.refusal;
  }
  // Refused before its batch, or by it for a reason of its own: the
  // caller may not even be allowed any more, so no outcome is read. A
  // conflict is the batch's, after every check: another attempt of the
  // same input may have committed first.
  const conflicted = knowledgeErrors.codeOf(error) === "knowledge.conflict";
  if (isExpectedError(error) && !conflicted) {
    throw error;
  }
  const receipt = await receiptOf(env, held.id);
  if (receipt !== undefined && receipt.outcome !== null) {
    // The caller may have lost what let it write since it was admitted:
    // the conflict, or the failed batch, came before or without its last
    // check.
    await lastCheck?.();
    return summaryOf(receipt.outcome);
  }
  if (conflicted) {
    throw error;
  }
  if (receipt !== undefined && receipt.fence !== held.fence) {
    throw submissionErrors.create("submission.superseded");
  }
  if (failedCheck(error, "submission_outcomes_open")) {
    throw submissionErrors.create("submission.expired");
  }
  if (failedCheck(error, "submission_outcomes_on_time")) {
    throw appErrors.create("app.caller_invalid");
  }
  if (failedCheck(error, "submission_outcomes_current")) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  throw error;
};

/**
 * Expires one page of the receipts due by `now`, and answers how many
 * were due. One whose outbox still owes an entry is not due; one whose
 * run is live is looked at again a day later, out of the way of the rest;
 * the others lose their outcome and settled entries and stay as
 * tombstones. The batch checks again that each is still due, so a commit
 * landing meanwhile, which keeps its receipt from then, keeps it.
 */
/** Whether a receipt's outbox owes nothing: every entry of it settled. */
const nothingOwed = sql`NOT EXISTS (SELECT 1 FROM ${submissionOutbox} WHERE ${submissionOutbox.receiptId} = ${submissionReceipts.id} AND ${submissionOutbox.settledAt} IS NULL)`;

const expirePage = async (env: Env, now: Date): Promise<number> => {
  const db = drizzle(env.KNOWLEDGE);
  const due = await db
    .select({ id: submissionReceipts.id, runId: submissionReceipts.runId })
    .from(submissionReceipts)
    .where(
      and(
        isNull(submissionReceipts.expiredAt),
        lte(submissionReceipts.retainUntil, now),
        nothingOwed
      )
    )
    .orderBy(asc(submissionReceipts.retainUntil), asc(submissionReceipts.id))
    .limit(sweepPage);
  if (due.length === 0) {
    return 0;
  }
  const live = await liveRuns(
    env,
    due.flatMap(({ runId }) => (runId === null ? [] : [runId]))
  );
  const kept = due.flatMap(({ id, runId }) =>
    runId !== null && live.has(runId) ? [id] : []
  );
  const expiring = due.flatMap(({ id, runId }) =>
    runId !== null && live.has(runId) ? [] : [id]
  );
  const stillDue = (ids: readonly string[]) =>
    and(
      inList(submissionReceipts.id, ids),
      isNull(submissionReceipts.expiredAt),
      lte(submissionReceipts.retainUntil, now),
      nothingOwed
    );
  const expiredNow = sql`IN (SELECT ${submissionReceipts.id} FROM ${submissionReceipts} WHERE ${submissionReceipts.expiredAt} = ${now.getTime()})`;
  await db.batch([
    db
      .update(submissionReceipts)
      .set({ retainUntil: new Date(now.getTime() + liveRunRecheckMs) })
      .where(stillDue(kept)),
    db
      .update(submissionReceipts)
      .set({ expiredAt: now })
      .where(stillDue(expiring)),
    // Only the settled entries and the outcomes of the receipts this page
    // expired, and never an outcome an entry still needs.
    db
      .delete(submissionOutbox)
      .where(
        and(
          inList(submissionOutbox.receiptId, expiring),
          isNotNull(submissionOutbox.settledAt),
          sql`${submissionOutbox.receiptId} ${expiredNow}`
        )
      ),
    db
      .delete(submissionOutcomes)
      .where(
        and(
          inList(submissionOutcomes.receiptId, expiring),
          sql`${submissionOutcomes.receiptId} ${expiredNow}`,
          sql`NOT EXISTS (SELECT 1 FROM ${submissionOutbox} WHERE ${submissionOutbox.receiptId} = ${submissionOutcomes.receiptId} AND ${submissionOutbox.settledAt} IS NULL)`
        )
      ),
  ]);
  return due.length;
};

/**
 * Deletes one page of the tombstones older than `submissionTombstoneDays`
 * by `now`, and answers how many there were.
 */
const deleteTombstonePage = async (env: Env, now: Date): Promise<number> => {
  const db = drizzle(env.KNOWLEDGE);
  const gone = await db
    .select({ id: submissionReceipts.id })
    .from(submissionReceipts)
    .where(
      and(
        isNotNull(submissionReceipts.expiredAt),
        lte(
          submissionReceipts.expiredAt,
          new Date(now.getTime() - submissionTombstoneDays * dayMs)
        )
      )
    )
    .orderBy(asc(submissionReceipts.expiredAt), asc(submissionReceipts.id))
    .limit(sweepPage);
  if (gone.length > 0) {
    await db.delete(submissionReceipts).where(
      inList(
        submissionReceipts.id,
        gone.map(({ id }) => id)
      )
    );
  }
  return gone.length;
};

/**
 * Runs `page` until one comes back short, or `budgetMs` has passed since
 * `started`.
 */
const paged = async (
  page: () => Promise<number>,
  started: number,
  budgetMs: number
): Promise<void> => {
  for (;;) {
    // One page after the other: each reads what the last left.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const count = await page();
    if (count < sweepPage || Date.now() - started >= budgetMs) {
      return;
    }
  }
};

/**
 * Expires the receipts kept long enough by `now`, and deletes the
 * tombstones kept long enough, a page at a time until a page comes back
 * short or `budgetMs` has passed (expirePage, deleteTombstonePage). Run by
 * the cron trigger; what is left goes in the next run.
 */
export const sweepReceipts = async (
  env: Env,
  now: Date,
  budgetMs = sweepBudgetMs
): Promise<void> => {
  const started = Date.now();
  await paged(async () => await expirePage(env, now), started, budgetMs);
  await paged(
    async () => await deleteTombstonePage(env, now),
    started,
    budgetMs
  );
};
