import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
// its caller as before. An admin may start a purge fresh instead: the
// unfinished one is kept as it stood, superseded by the new one. The record holds who,
// when, which documents (as its audit event does) and counts: never a
// term, text or anything else the purge erased.

type PurgeInput = z.output<typeof purgeInputSchema>;

/** How long a run holds a step before another may take it over. */
export const purgeStepLeaseMs = 10 * 60 * 1000;

/** What a step changed: counts, by name. */
export type StepCounts = Record<string, number>;

/** A purge's record, as opened to run (`openPurge`). */
export interface OpenPurge {
  purgeId: string;
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
): BatchItem<"sqlite">[] =>
  steps.length === 0
    ? []
    : [
        db
          .insert(brainPurgeSteps)
          .values(
            steps.map((step, index) => ({
              purgeId,
              step,
              position: from + index,
              updatedAt: now,
            }))
          )
          .onConflictDoNothing(),
      ];

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
  if (open !== undefined && !fresh) {
    // A step the purge names now that it didn't before (a document's
    // step is named by the document): queued after the rest.
    await queueSteps(brain, open.id, steps, now);
    return {
      purgeId: open.id,
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
  return { purgeId, resumed: false, counts };
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
 * Runs step `step` of purge `purgeId` with `run`, also when it ran before
 * (what holds a term may have been written since): what it changes adds
 * to what it stored, which is answered. Claimed first under a token of
 * its own, so two runs never run the same step, and only the run holding
 * the claim sets how it ended: one held by another run, within its lease,
 * refuses as `knowledge.conflict`.
 */
export const runStep = async <C>(
  brain: Brain<C>,
  purgeId: string,
  step: string,
  /** Answers what it changed, as counts, or nothing to count. */
  run: () => Promise<unknown>
): Promise<StepCounts> => {
  const { db } = brain;
  const now = brain.ports.clock();
  const mine = and(
    eq(brainPurgeSteps.purgeId, purgeId),
    eq(brainPurgeSteps.step, step)
  );
  const claim = crypto.randomUUID();
  const claimed = await db
    .update(brainPurgeSteps)
    .set({
      state: "running",
      claim,
      claimedAt: now,
      reason: null,
      updatedAt: now,
    })
    .where(
      and(
        mine,
        or(
          inArray(brainPurgeSteps.state, ["queued", "blocked", "complete"]),
          and(
            eq(brainPurgeSteps.state, "running"),
            lt(
              brainPurgeSteps.claimedAt,
              new Date(now.getTime() - purgeStepLeaseMs)
            )
          )
        )
      )
    )
    .returning({ counts: brainPurgeSteps.counts });
  const [held] = claimed;
  if (held === undefined) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  const before = countsOf(held.counts);
  const ours = and(mine, eq(brainPurgeSteps.claim, claim));
  let changed: StepCounts;
  try {
    changed = countsOf(JSON.stringify((await run()) ?? {}));
  } catch (error) {
    await db
      .update(brainPurgeSteps)
      .set({
        state: "blocked",
        reason: reasonOf(error),
        claim: null,
        claimedAt: null,
        updatedAt: brain.ports.clock(),
      })
      .where(ours);
    throw error;
  }
  const counts = added(before, changed);
  const ended = await db
    .update(brainPurgeSteps)
    .set({
      state: "complete",
      counts: JSON.stringify(counts),
      claim: null,
      claimedAt: null,
      updatedAt: brain.ports.clock(),
    })
    .where(ours)
    .returning({ step: brainPurgeSteps.step });
  // Taken over past its lease: the run that took it says how it ended.
  if (ended.length === 0) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  return counts;
};

/** Marks purge `purgeId` finished once every step of it is complete. */
export const finishPurge = async <C>(
  brain: Brain<C>,
  purgeId: string
): Promise<void> => {
  const now = brain.ports.clock();
  await brain.db
    .update(brainPurges)
    .set({ completedAt: now, updatedAt: now })
    .where(
      and(
        eq(brainPurges.id, purgeId),
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
