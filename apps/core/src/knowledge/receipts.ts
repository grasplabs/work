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
import { runOfStepKey } from "@grasp-os/shared/workflows";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { workflowRuns } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import {
  documents,
  submissionOutcomes,
  submissionReceipts,
} from "../db/knowledge/schema.ts";

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
//   attempt claimed the receipt since.
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
// - A key crosses callers or resources: a receipt's ID hashes its whole
//   scope with the key (the person, the chain of Apps, the App's version
//   and method, the collection, its permission and the operation), so the
//   same key elsewhere is another receipt, and the caller is authorized
//   in full before a receipt is read, so a key never lets anyone read an
//   outcome they couldn't make now.

const dayMs = 24 * 60 * 60 * 1000;

/** Most receipts one sweep expires, and most tombstones it deletes. */
const sweepPage = 100;

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
}

/** An attempt holding a receipt, for its commit. */
export interface Claim {
  id: string;
  fence: number;
  deadline: number;
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
        key: ["step", stepKey, key ?? inputHash],
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
  const id = await receiptIdOf(submission);
  const db = drizzle(env.KNOWLEDGE);
  // One statement: a new receipt, or the fence moved on, but only for the
  // same input, before it expired and before it committed.
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
      retainUntil: new Date(now.getTime() + submissionRetentionDays * dayMs),
    })
    .onConflictDoUpdate({
      target: submissionReceipts.id,
      set: { fence: sql`${submissionReceipts.fence} + 1` },
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
      claim: { id, fence: claimed.fence, deadline: submission.deadline },
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
 * The statement that commits `held`'s outcome, `outcome`, in the batch of
 * its save: refused, with the batch, unless `held` still has the
 * receipt's fence and its deadline hasn't passed by the database's
 * clock, and, for a save that changes nothing (`unchanged`), unless the
 * document is still at the version the save expected.
 */
export const commitOf = (
  env: Env,
  held: Claim,
  outcome: DocumentSummary,
  unchanged?: { documentId: string; version: number }
): BatchItem<"sqlite"> =>
  drizzle(env.KNOWLEDGE)
    .insert(submissionOutcomes)
    .values({
      receiptId: held.id,
      fence: held.fence,
      // Milliseconds since the epoch, by the database's clock.
      onTime: sql`(unixepoch('subsec') * 1000) < ${held.deadline}`,
      current:
        unchanged === undefined
          ? true
          : sql`EXISTS (SELECT 1 FROM ${documents} WHERE ${documents.id} = ${unchanged.documentId} AND ${documents.currentVersion} = ${unchanged.version})`,
      outcome: JSON.stringify(outcome),
      committedAt: new Date(),
    });

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
 * changes nothing found the record moved on; `error` otherwise.
 */
export const settled = async (
  env: Env,
  held: Claim,
  error: unknown
): Promise<DocumentSummary> => {
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
    return summaryOf(receipt.outcome);
  }
  if (conflicted) {
    throw error;
  }
  if (receipt !== undefined && receipt.fence !== held.fence) {
    throw submissionErrors.create("submission.superseded");
  }
  if (failedCheck(error, "submission_outcomes_on_time")) {
    throw appErrors.create("app.caller_invalid");
  }
  if (failedCheck(error, "submission_outcomes_current")) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  throw error;
};

/** The runs of `runIds` that are live: started and not yet ended. */
const liveRuns = async (
  env: Env,
  runIds: readonly string[]
): Promise<Set<string>> => {
  if (runIds.length === 0) {
    return new Set();
  }
  const rows = await drizzle(env.DB)
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        inList(workflowRuns.id, runIds),
        inArray(workflowRuns.status, ["starting", "running", "paused"])
      )
    );
  return new Set(rows.map(({ id }) => id));
};

/**
 * Expires the receipts kept long enough, at most a page of each a call:
 * those past their `retain_until` whose run, if any, is no longer live
 * lose their outcome and stay as tombstones; tombstones older than
 * `submissionTombstoneDays` go. A receipt whose run is live is kept, and
 * looked at again the next time. Run by the cron trigger.
 */
export const sweepReceipts = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.KNOWLEDGE);
  const due = await db
    .select({ id: submissionReceipts.id, runId: submissionReceipts.runId })
    .from(submissionReceipts)
    .where(
      and(
        isNull(submissionReceipts.expiredAt),
        lte(submissionReceipts.retainUntil, now)
      )
    )
    .orderBy(asc(submissionReceipts.retainUntil), asc(submissionReceipts.id))
    .limit(sweepPage);
  const live = await liveRuns(
    env,
    due.flatMap(({ runId }) => (runId === null ? [] : [runId]))
  );
  const expiring = due
    .filter(({ runId }) => runId === null || !live.has(runId))
    .map(({ id }) => id);
  if (expiring.length > 0) {
    await db.batch([
      db
        .delete(submissionOutcomes)
        .where(inList(submissionOutcomes.receiptId, expiring)),
      db
        .update(submissionReceipts)
        .set({ expiredAt: now })
        .where(inList(submissionReceipts.id, expiring)),
    ]);
  }
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
};
