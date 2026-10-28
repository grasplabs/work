import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { z } from "zod";

import type { Brain } from "./brain.ts";
import { brainPurgeSteps, brainPurges } from "./db/schema.ts";
import type { Writer } from "./documents.ts";
import { toBase64Url } from "./encoding.ts";
import { canonicalJson } from "./json.ts";
import { knowledgeErrors } from "./knowledge.ts";
import type { PurgeStatus, purgeInputSchema } from "./knowledge.ts";

// Each purge as a durable erasure (GRA-1122, GRA-309's S1; the threat
// model is on the issue): one record of the purge, and one of each
// projection it reaches, as a step that is queued, running, complete or
// blocked. A purge run again with the same input resumes its record: it
// begins once (one `knowledge.purged` event, one owed rebuild), and every
// step runs again, a complete one too, since what holds a term may have
// been written since the last run (the GRA-1122 security review); what it
// changed adds to what it stored. A step that fails is blocked with a
// stable code, never an error's message, and the purge's error goes on to
// its caller as before. Each run of a purge is an attempt: it takes the
// purge under a token of its own, renews its hold with each step's own
// writes, and only it changes the purge or its steps, so a trailing run
// never changes one another finished or took over. Each attempt owes its
// own rebuild. An admin may start a purge fresh instead: the
// unfinished one is kept as it stood, superseded by the new one. The record holds who,
// when, which documents (as its audit event does) and counts: never a
// term, text or anything else the purge erased.

type PurgeInput = z.output<typeof purgeInputSchema>;

/** How long an attempt holds its purge, from its last step, before another may take it over. */
export const purgeAttemptLeaseMs = 10 * 60 * 1000;

/**
 * Step rows one insert writes: D1 binds at most 100 values a statement,
 * and drizzle binds every column of a row, defaults too (seven).
 */
const stepRowsPerStatement = 14;

/** What a step changed: counts, by name. */
export type StepCounts = Record<string, number>;

/** A purge as one attempt holds it: what its steps run under. */
export interface PurgeAttempt {
  purgeId: string;
  /** The attempt's token (`brain_purges.attempt`). */
  attempt: string;
}

/** A purge's record, as opened to run (`openPurge`). */
export interface OpenPurge extends PurgeAttempt {
  /** Whether it was begun before, and is resumed. */
  resumed: boolean;
  /** What it counted as it began. */
  counts: StepCounts;
}

const ledgerKey = async <C>(brain: Brain<C>): Promise<CryptoKey> =>
  await brain.ports.keys.hmac("grasp-os knowledge purge ledger", ["sign"]);

/** `input` as the same purge, however its lists were ordered. */
const canonicalInput = (input: PurgeInput): PurgeInput =>
  input.type === "personal"
    ? input
    : {
        ...input,
        documentIds: input.documentIds.toSorted(),
        terms: input.terms.toSorted(),
      };

/**
 * The keyed digest of `input`: the same input finds the same purge, and
 * nothing without the Brain's key tells what it was.
 */
const keyOf = async <C>(brain: Brain<C>, input: PurgeInput): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await ledgerKey(brain),
        new TextEncoder().encode(canonicalJson(canonicalInput(input)))
      )
    )
  );

const stepRows = <C>(
  { db }: Brain<C>,
  purgeId: string,
  steps: readonly string[],
  from: number,
  now: Date
): BatchItem<"sqlite">[] => {
  const rows = steps.map((step, index) => ({
    purgeId,
    step,
    position: from + index,
    updatedAt: now,
  }));
  const statements: BatchItem<"sqlite">[] = [];
  for (let at = 0; at < rows.length; at += stepRowsPerStatement) {
    statements.push(
      db
        .insert(brainPurgeSteps)
        .values(rows.slice(at, at + stepRowsPerStatement))
        .onConflictDoNothing()
    );
  }
  return statements;
};

/** Queues those of `steps` purge `purgeId` doesn't have yet. */
const queueSteps = async <C>(
  brain: Brain<C>,
  purgeId: string,
  steps: readonly string[],
  now: Date
): Promise<void> => {
  const known = await brain.db
    .select({ step: brainPurgeSteps.step })
    .from(brainPurgeSteps)
    .where(eq(brainPurgeSteps.purgeId, purgeId));
  const have = new Set(known.map(({ step }) => step));
  const missing = steps.filter((step) => !have.has(step));
  const [first, ...rest] = stepRows(brain, purgeId, missing, known.length, now);
  if (first !== undefined) {
    await brain.db.batch([first, ...rest]);
  }
};

const countsOf = (stored: string | null): StepCounts => {
  if (stored === null) {
    return {};
  }
  const parsed: unknown = JSON.parse(stored);
  if (parsed === null || typeof parsed !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number"
    )
  );
};

/**
 * Whether purge `purgeId` is held by attempt `attempt`, its hold renewed
 * at `at` (in the same batch): open, not superseded.
 */
export const attemptHolds = ({ purgeId, attempt }: PurgeAttempt, at: Date) =>
  sql`EXISTS (SELECT 1 FROM ${brainPurges} WHERE ${brainPurges.id} = ${purgeId} AND ${brainPurges.attempt} = ${attempt} AND ${brainPurges.attemptAt} = ${at.getTime()} AND ${brainPurges.completedAt} IS NULL AND ${brainPurges.supersededBy} IS NULL)`;

/**
 * Renews `held`'s hold on its purge to `now`, unless it lapsed, was taken
 * over, or the purge finished: what a step's writes are conditional on
 * (`attemptHolds`), in the same batch.
 */
const renewHold = <C>(brain: Brain<C>, held: PurgeAttempt, now: Date) =>
  brain.db
    .update(brainPurges)
    .set({ attemptAt: now, updatedAt: now })
    .where(
      and(
        eq(brainPurges.id, held.purgeId),
        eq(brainPurges.attempt, held.attempt),
        gt(
          brainPurges.attemptAt,
          new Date(now.getTime() - purgeAttemptLeaseMs)
        ),
        isNull(brainPurges.completedAt),
        isNull(brainPurges.supersededBy)
      )
    );

/**
 * The record of the unfinished purge of `input`, resumed, or a new one,
 * with `steps` queued, written in one batch with what `begin` writes when
 * the purge begins (its audit event, the rebuild it owes): never twice.
 */
export const openPurge = async <C>(
  brain: Brain<C>,
  by: Writer,
  input: PurgeInput,
  steps: readonly string[],
  counts: StepCounts,
  begin: (purgeId: string) => BatchItem<"sqlite">[],
  /**
   * What each attempt writes as it takes the purge (the rebuild it owes),
   * conditional on `held` (`attemptHolds`) holding it at `at`.
   */
  renew: (held: PurgeAttempt, at: Date) => BatchItem<"sqlite">[],
  /** Begins anew, the open one kept as it stood, superseded. */
  fresh = false
): Promise<OpenPurge> => {
  const { db } = brain;
  const key = await keyOf(brain, input);
  const [open] = await db
    .select({ id: brainPurges.id, counts: brainPurges.counts })
    .from(brainPurges)
    .where(
      and(
        eq(brainPurges.key, key),
        isNull(brainPurges.completedAt),
        isNull(brainPurges.supersededBy)
      )
    )
    .limit(1);
  const now = brain.ports.clock();
  const attempt = crypto.randomUUID();
  if (open !== undefined && !fresh) {
    // A step the purge names now that it didn't before (a document's
    // step is named by the document): queued after the rest.
    await queueSteps(brain, open.id, steps, now);
    const held = { purgeId: open.id, attempt };
    // Taken for this attempt, unless another holds it within its lease
    // or it finished meanwhile; with the rebuild this attempt owes.
    const [taken] = await db.batch([
      db
        .update(brainPurges)
        .set({ attempt, attemptAt: now, updatedAt: now })
        .where(
          and(
            eq(brainPurges.id, open.id),
            isNull(brainPurges.completedAt),
            isNull(brainPurges.supersededBy),
            or(
              isNull(brainPurges.attemptAt),
              lt(
                brainPurges.attemptAt,
                new Date(now.getTime() - purgeAttemptLeaseMs)
              )
            )
          )
        )
        .returning({ id: brainPurges.id }),
      ...renew(held, now),
    ]);
    if (taken.length === 0) {
      throw knowledgeErrors.create("knowledge.conflict");
    }
    return {
      ...held,
      resumed: true,
      counts: countsOf(open.counts),
    };
  }
  const purgeId = crypto.randomUUID();
  try {
    const supersede: BatchItem<"sqlite">[] =
      open === undefined
        ? []
        : [
            db
              .update(brainPurges)
              .set({ supersededBy: purgeId, updatedAt: now })
              .where(
                and(
                  eq(brainPurges.id, open.id),
                  isNull(brainPurges.supersededBy)
                )
              ),
          ];
    const begun: BatchItem<"sqlite"> = db.insert(brainPurges).values({
      id: purgeId,
      kind: input.type,
      key,
      by: by.userId,
      counts: JSON.stringify(counts),
      attempt,
      attemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    // First the one it begins in place of, kept, superseded: one open
    // purge of an input at a time.
    const [first, ...rest] = [
      ...supersede,
      begun,
      ...stepRows(brain, purgeId, steps, 0, now),
      ...begin(purgeId),
      ...renew({ purgeId, attempt }, now),
    ];
    await db.batch([first ?? begun, ...rest]);
  } catch (error) {
    // The same purge begun by another run at the same time: theirs runs.
    if (String(error).includes("UNIQUE")) {
      throw knowledgeErrors.create("knowledge.conflict");
    }
    throw error;
  }
  brain.ports.audit.drain();
  return { purgeId, attempt, resumed: false, counts };
};

/** Why a step failed, as a stable code: never a message. */
const reasonOf = (error: unknown): string =>
  knowledgeErrors.codeOf(error) ??
  (error instanceof Error ? error.name : "unknown");

/** `a` and `b` added up, count by count. */
const added = (a: StepCounts, b: StepCounts): StepCounts => {
  const total: StepCounts = { ...a };
  for (const [name, value] of Object.entries(b)) {
    total[name] = (total[name] ?? 0) + value;
  }
  return total;
};

/**
 * Runs step `step` of the purge `held` holds with `run`, also when it ran
 * before (what holds a term may have been written since): what it changes
 * adds to what it stored, which is answered. Each of its writes renews
 * the attempt's hold in the same batch and is made only under it: an
 * attempt whose lease lapsed, that was taken over, or whose purge
 * finished refuses as `knowledge.conflict` and changes nothing.
 */
export const runStep = async <C>(
  brain: Brain<C>,
  held: PurgeAttempt,
  step: string,
  /** Answers what it changed, as counts, or nothing to count. */
  run: () => Promise<unknown>
): Promise<StepCounts> => {
  const { db } = brain;
  const mine = and(
    eq(brainPurgeSteps.purgeId, held.purgeId),
    eq(brainPurgeSteps.step, step)
  );
  /**
   * Writes `set` to the step under the attempt's renewed hold, and lets
   * the hold go after when `release`: whether it held.
   */
  const underHold = async (
    set: Partial<typeof brainPurgeSteps.$inferInsert>,
    release = false
  ): Promise<{ counts: string | null } | undefined> => {
    const now = brain.ports.clock();
    const [, written] = await db.batch([
      renewHold(brain, held, now),
      db
        .update(brainPurgeSteps)
        .set({ ...set, updatedAt: now })
        .where(and(mine, attemptHolds(held, now)))
        .returning({ counts: brainPurgeSteps.counts }),
      ...(release
        ? [
            db
              .update(brainPurges)
              .set({ attempt: null, attemptAt: null, updatedAt: now })
              .where(
                and(
                  eq(brainPurges.id, held.purgeId),
                  eq(brainPurges.attempt, held.attempt)
                )
              ),
          ]
        : []),
    ]);
    return written[0];
  };
  const started = await underHold({ state: "running", reason: null });
  if (started === undefined) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  const before = countsOf(started.counts);
  let changed: StepCounts;
  try {
    changed = countsOf(JSON.stringify((await run()) ?? {}));
  } catch (error) {
    // Blocked, and the purge let go: run again, it goes on at once.
    await underHold({ state: "blocked", reason: reasonOf(error) }, true);
    throw error;
  }
  const counts = added(before, changed);
  const ended = await underHold({
    state: "complete",
    counts: JSON.stringify(counts),
  });
  // Taken over, lapsed, or finished meanwhile: this attempt says nothing.
  if (ended === undefined) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  return counts;
};

/**
 * Marks the purge `held` holds finished once every step of it is
 * complete, its hold let go: only under that attempt's hold.
 */
export const finishPurge = async <C>(
  brain: Brain<C>,
  held: PurgeAttempt
): Promise<void> => {
  const now = brain.ports.clock();
  const { purgeId } = held;
  await brain.db
    .update(brainPurges)
    .set({ completedAt: now, attempt: null, attemptAt: null, updatedAt: now })
    .where(
      and(
        eq(brainPurges.id, purgeId),
        eq(brainPurges.attempt, held.attempt),
        gt(
          brainPurges.attemptAt,
          new Date(now.getTime() - purgeAttemptLeaseMs)
        ),
        isNull(brainPurges.supersededBy),
        sql`NOT EXISTS (SELECT 1 FROM ${brainPurgeSteps} WHERE ${brainPurgeSteps.purgeId} = ${purgeId} AND ${brainPurgeSteps.state} <> 'complete')`
      )
    );
};

/**
 * Where purge `purgeId` stands: each step's state, why one is blocked,
 * and what each changed. `knowledge.not_found` for none. Who may read it
 * is the host's to decide before (core: the client's admins).
 */
export const purgeStatus = async <C>(
  brain: Brain<C>,
  purgeId: string
): Promise<PurgeStatus> => {
  const { db } = brain;
  const [purge] = await db
    .select()
    .from(brainPurges)
    .where(eq(brainPurges.id, purgeId));
  if (purge === undefined) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const steps = await db
    .select()
    .from(brainPurgeSteps)
    .where(eq(brainPurgeSteps.purgeId, purgeId))
    .orderBy(asc(brainPurgeSteps.position));
  let state: PurgeStatus["state"] = "running";
  // Superseded first: a run of it that finished later doesn't make it the
  // purge in force.
  if (purge.supersededBy !== null) {
    state = "superseded";
  } else if (purge.completedAt !== null) {
    state = "complete";
  } else if (steps.some(({ state: each }) => each === "blocked")) {
    state = "blocked";
  }
  return {
    purgeId,
    kind: purge.kind,
    state,
    createdAt: purge.createdAt.toISOString(),
    completedAt: purge.completedAt?.toISOString() ?? null,
    supersededBy: purge.supersededBy,
    steps: steps.map((each) => ({
      step: each.step,
      state: each.state,
      reason: each.reason,
      counts: countsOf(each.counts),
    })),
  };
};
