import { deploymentConfig } from "@grasp-os/shared/config";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import {
  lowerableLimits,
  quotaLimitsSchema,
  quotaPolicyOf,
} from "@grasp-os/shared/quota-policy";
import type {
  LowerableLimit,
  QuotaPolicy,
} from "@grasp-os/shared/quota-policy";
import { executionErrors, workflowErrors } from "@grasp-os/shared/workflows";
import { and, desc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  quotaPolicies,
  runLineageAttempts,
  runLineageChildren,
  runLineages,
  workflowResourceRuns,
  workflowRuns,
} from "../db/core/schema.ts";
import {
  attemptPool,
  dequeued,
  queuedRefusal,
  queuePlaceOf,
  queuePruned,
  roomFor,
  sharesOf,
  sharesRead,
  standingOf,
} from "./admission.ts";
import type { AdmissionScope, QueuePlace } from "./admission.ts";

// A run lineage's quotas: how deep its runs nest, how many runs it starts,
// how long its steps' attempts run in all and how old it may grow, each
// against the deployment's quota policy (@grasp-os/shared/quota-policy),
// counted durably in core's database (`run_lineages`,
// `run_lineage_attempts`), and checked as each piece of work is admitted:
// a child run as it starts (`admitChild`), a step's attempt before its
// code runs (`admitAttempt`). A run's own steps are bounded by the
// engine's journal, which every activation replays (host.ts,
// `countedStep`).
//
// From the threat model, each way a lineage could get past a limit, and
// what closes it:
//
// - A retry starting afresh: an attempt is admitted against the lineage's
//   counters, which only grow, and its number, which the engine journals,
//   against the attempts a step may have, whatever its code declares; a
//   step declaring more retries than the platform's is refused (host.ts,
//   `doOptionsSchema`). The ceiling is per round of a step: one whose side
//   effect was held runs again, once decided, in a step of core's own
//   with attempts afresh, every round held to the lineage's active time.
// - A restart or a new activation starting afresh: nothing is counted in
//   memory. An activation that runs an attempt again is admitted again:
//   the attempt runs, and uses time, again.
// - A child, or a child of a child, starting afresh: a run started under
//   another joins the lineage of its parent's root and sits one deeper,
//   both read from the parent's row, never from what any run is given.
//   Its slot is counted on the root's row, and is never given back, even
//   when its start then fails. A trigger's deliveries of one message are
//   one child, in one slot, claimed by its key (`run_lineage_children`).
// - Admissions racing past a limit: each is one conditional statement in
//   one batch (a transaction), which changes the counters only if the work
//   fits as they stand then. No count is read first and written after.
// - Waits stretching a lineage's life: sleeps, event waits and decisions
//   hold no attempt, so they use none of its active time, but its age
//   counts from its root's start and nothing moves that.
// - An attempt that dies before it settles: once its deadline has passed
//   it is settled as having used all it could, its deadline less its
//   admission. A late settle changes nothing: an attempt settles once.
//   One the engine fenced sooner (its run paused, ended or cancelled, its
//   activation taken over) is settled as the engine says so, having used
//   what it ran (`sharesReleased`, `fencedSettled`).
//
// What an attempt holds while it runs is its allowance up to its
// deadline, which is never more than an attempt's active wall time
// (`platformLimits.workflowAttemptWallMs`, a minute): the most a step may
// declare, and what it gets when it declares none (host.ts,
// `stepConfig`). The hold is capped at that minute here too, so a
// deadline from anywhere else can't hold more. What it settles with is
// what it used, up to its deadline.
// - A resource declaring wider limits: none reaches here. What a workflow
//   declares can only lower what applies to it (host.ts,
//   `doOptionsSchema`).
// - The operator raising a limit: the policy's schema refuses a value
//   above the platform's (quota-policy.ts); a var that doesn't parse is
//   never one without limits.
// - Two policies under one generation, or a policy going back to an
//   older one (a deploy that failed after core went live, then another):
//   core records each generation's limits the first time it sees it, and
//   applies only the highest recorded, as recorded (`quotaPolicy`).
// - A policy change missed: the policy is read at each admission and
//   compared with the counters as they are; nothing admitted keeps the
//   limits it was admitted under. Each admission records the policy's
//   generation.
// - A database that can't answer: nothing is admitted. The attempt fails
//   as the platform's unexpected error, which its step may retry.
//
// A lineage's host calls (every call an attempt's code makes through its
// host, `AttemptHost`) are counted on its row too, each attempt reserving
// them in blocks as it calls (`hostCallsOf`), so most calls take no write.
// How a lineage could make more than it may, and what closes it:
//
// - A retry, a restart or a new activation starting afresh: the count is
//   the lineage's, in its row; what an attempt keeps in memory is only how
//   much of its own reservation it has used.
// - A child, or a child of a child: its attempts count on its root's row,
//   as its runs and active time do.
// - Calls racing each other: an attempt's calls take from its reservation
//   one at a time, and only one block of it is reserved at once; each
//   block is one conditional statement that grants no more than the
//   lineage has left. Attempts racing each other each reserve that way.
// - Giving back more than was left over: an attempt gives back what it
//   reserved and didn't use once, as it settles, in the statement that
//   settles it, or, settled sooner as the engine fenced it, in the one
//   that marks its calls settled (`calls_settled`); an attempt that never settles (its activation died) gives
//   back nothing, and an attempt settled already reserves nothing more.
//   What a block left unused while an attempt died is lost to the
//   lineage: blocks start at one call and double, so at most about as
//   many as the attempt made.
// - A replay: a step the engine journaled answers without its function,
//   and makes no call. An attempt run again makes its calls, and counts
//   them, again.
// - A step catching the refusal and calling again in a loop, on every
//   retry: once the lineage has none left, an attempt refuses its calls
//   without asking the database again, and no new attempt of the lineage
//   is admitted.
// - Parallel branches: the SDK runs a run's steps one after another
//   (`exclusive`), and code that gets past it runs steps that still call
//   through their attempts' hosts, counted on the same row.
//
// Refusals say which they are: a limit reached for good
// (`workflow.lineage_limit`, naming the limit), or a lineage whose active
// time is held by attempts still under way, which a retry after the
// seconds it names may find room in (`workflow.lineage_busy`).

/** `limits` as text that is the same for the same limits, in any order. */
const canonicalLimits = (limits: Record<string, number | undefined>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(limits)
        .filter(([, value]) => value !== undefined)
        .toSorted(([a], [b]) => a.localeCompare(b))
    )
  );

/** Limits as `quota_policies` keeps them: names to whole numbers. */
const storedLimitsSchema = z.record(z.string(), z.int().min(1));

/**
 * The policy of a generation `quota_policies` recorded: its limits, each
 * no higher than the platform's now (a later release may have lowered
 * one), the platform's for any it doesn't set.
 */
const recordedPolicy = (row: {
  generation: number;
  limits: string;
}): QuotaPolicy => {
  const stored = storedLimitsSchema.safeParse(JSON.parse(row.limits)).data;
  const { limits } = quotaPolicyOf();
  const lowered = Object.fromEntries(
    lowerableLimits.map((name): [LowerableLimit, number] => [
      name,
      Math.min(stored?.[name] ?? limits[name], limits[name]),
    ])
  );
  return {
    generation: row.generation,
    limits: { ...limits, ...lowered },
  };
};

/** The generation `quota_policies` recorded highest, if any. */
const highestRecorded = async (db: DrizzleD1Database) =>
  await db
    .select({
      generation: quotaPolicies.generation,
      limits: quotaPolicies.limits,
      limitsHash: quotaPolicies.limitsHash,
    })
    .from(quotaPolicies)
    .orderBy(desc(quotaPolicies.generation))
    .limit(1)
    .get();

/** The refusals of a `QUOTA_LIMITS` logged in this isolate, once each. */
const refusalsLogged = new Set<string>();

/**
 * The deployment's quota policy now: the platform's, as its operator
 * lowered it with `QUOTA_LIMITS`, and as core recorded it. Core is the
 * authority on which policy applies, as it admits the work, whatever was
 * deployed:
 * - The first time it sees a generation higher than any it recorded, it
 *   records the generation with its limits (`quota_policies`), once,
 *   whichever isolate is first: one that loses the race reads the
 *   winner's.
 * - A var under the highest recorded generation with the limits recorded
 *   for it applies.
 * - Anything else (a lower generation, the highest with other limits, or
 *   no var or one that doesn't parse once a generation is recorded) is
 *   refused: logged as `config.invalid` at error level, once per isolate,
 *   and the highest recorded generation's policy applies. A conflicting
 *   policy never applies, and none goes back to an older one.
 * With nothing recorded and no var, or one that doesn't parse
 * (`deploymentConfig` logs it), the platform's own policy applies.
 */
export const quotaPolicy = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">
): Promise<QuotaPolicy> => {
  const configured = deploymentConfig(
    quotaLimitsSchema,
    "QUOTA_LIMITS",
    env.QUOTA_LIMITS
  );
  const db = drizzle(env.DB);
  const limits =
    configured === undefined ? undefined : canonicalLimits(configured.limits);
  const hash = limits === undefined ? undefined : await sha256Hex(limits);
  let highest = await highestRecorded(db);
  if (
    configured !== undefined &&
    limits !== undefined &&
    hash !== undefined &&
    (highest === undefined || configured.generation > highest.generation)
  ) {
    await db
      .insert(quotaPolicies)
      .values({
        generation: configured.generation,
        limits,
        limitsHash: hash,
        recordedAt: new Date(),
      })
      .onConflictDoNothing();
    highest = await highestRecorded(db);
  }
  if (highest === undefined) {
    return quotaPolicyOf(configured);
  }
  if (
    configured !== undefined &&
    highest.generation === configured.generation &&
    highest.limitsHash === hash
  ) {
    return quotaPolicyOf(configured);
  }
  const refusal = `${String(configured?.generation)}:${hash ?? ""}:${String(highest.generation)}`;
  if (!refusalsLogged.has(refusal)) {
    refusalsLogged.add(refusal);
    const behind =
      configured !== undefined && configured.generation < highest.generation;
    log.error("config.invalid", {
      var: "QUOTA_LIMITS",
      reason: behind ? "generation_behind" : "generation_conflict",
      ...(configured === undefined
        ? {}
        : { generation: configured.generation }),
      kept: highest.generation,
    });
  }
  return recordedPolicy(highest);
};

/** The limits a lineage reaches, as a refusal names them. */
const lineageLimits = {
  steps: "workflowSteps",
  nesting: "workflowNestingLevels",
  descendants: "workflowDescendantRuns",
  activeTime: "workflowActiveMs",
  age: "workflowAgeMs",
  hostCalls: "lineageHostCalls",
} as const satisfies Record<string, LowerableLimit>;

type LineageLimit = keyof typeof lineageLimits;

/** The refusal of work past a lineage's `limit`, under `policy`. */
const limitReached = (limit: LineageLimit, policy: QuotaPolicy) =>
  workflowErrors.create("workflow.lineage_limit", {
    limit,
    max: policy.limits[lineageLimits[limit]],
    generation: policy.generation,
  });

/**
 * The statement that creates the lineage of `root` (a root run's ID) from
 * its run's row, unless it has its row already: its age counts from the
 * root's start. A root is an App's run (`workflow_runs`) or an
 * independent workflow's (`workflow_resource_runs`, its start's
 * admission): the same counters and admissions hold both, so no run gets
 * past a limit for being of either kind. Nothing for a run core has no
 * row of.
 */
export const lineageCreated = (db: DrizzleD1Database, root: string) =>
  db
    .insert(runLineages)
    .select(
      sql`SELECT ${workflowRuns.id}, ${workflowRuns.createdAt}, 0, 0, 0, 0, 0 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${root}
        UNION ALL SELECT ${workflowResourceRuns.id}, ${workflowResourceRuns.createdAt}, 0, 0, 0, 0, 0 FROM ${workflowResourceRuns} WHERE ${workflowResourceRuns.id} = ${root}`
    )
    .onConflictDoNothing();

/**
 * That run `run` was cancelled, as SQL: an App run's tombstone, or an
 * independent run ended cancelled (resource-runs.ts, which ends it as
 * the cancel is taken). Its attempts are charged up to their deadlines,
 * as the engine stops a cancelled attempt's calls, not its isolate.
 */
const cancelledRun = (run: string): SQL =>
  sql`(EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${run} AND ${workflowRuns.cancelRequestedAt} IS NOT NULL)
    OR EXISTS (SELECT 1 FROM ${workflowResourceRuns} WHERE ${workflowResourceRuns.id} = ${run} AND ${workflowResourceRuns.status} = 'cancelled'))`;

/**
 * That the engine has fenced run `run`'s attempts of activation
 * `generation`, as SQL: the run was cancelled (`cancelledRun`), its object
 * said its attempts of this generation, or a newer one, hold no more
 * (`sharesReleased`), or, for an independent run, it has ended. However
 * late an admission of such an attempt lands, it takes no share.
 */
const fencedRun = (run: string, generation: number): SQL =>
  sql`(${cancelledRun(run)}
    OR EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${run} AND ${workflowRuns.sharesFencedThrough} >= ${generation})
    OR EXISTS (SELECT 1 FROM ${workflowResourceRuns} WHERE ${workflowResourceRuns.id} = ${run} AND (${workflowResourceRuns.sharesFencedThrough} >= ${generation} OR ${workflowResourceRuns.status} IN ('completed', 'failed', 'cancelled'))))`;

/**
 * The statements that record, for run `run` of either kind, that the
 * engine fenced its attempts of activation generation `through` and older
 * (`shares_fenced_through`, which only grows). An independent run that has
 * ended is fenced by its end already (`fencedRun`), and its row never
 * changes again (migration 0089), so only one that hasn't is written.
 */
const fenceRecorded = (db: DrizzleD1Database, run: string, through: number) =>
  [
    db
      .update(workflowRuns)
      .set({ sharesFencedThrough: through })
      .where(
        and(
          eq(workflowRuns.id, run),
          lt(workflowRuns.sharesFencedThrough, through)
        )
      ),
    db
      .update(workflowResourceRuns)
      .set({ sharesFencedThrough: through })
      .where(
        and(
          eq(workflowResourceRuns.id, run),
          lt(workflowResourceRuns.sharesFencedThrough, through),
          sql`${workflowResourceRuns.status} IN ('starting', 'running')`
        )
      ),
  ] as const;

/**
 * That `policy`'s generation is still the highest `quota_policies`
 * recorded, as SQL: a condition of each admission's statement, so a
 * policy read just before a newer generation was recorded admits nothing
 * under it (`policyStill`).
 */
export const stillCurrent = (policy: QuotaPolicy): SQL =>
  sql`${policy.generation} >= coalesce((SELECT max(${quotaPolicies.generation}) FROM ${quotaPolicies}), 0)`;

/**
 * Whether `policy` is still the one to admit by: no higher generation was
 * recorded since it was read. One that isn't is read again, and the
 * admission tried again under it, once.
 */
export const policyStill = async (
  db: DrizzleD1Database,
  policy: QuotaPolicy
): Promise<boolean> => {
  const highest = await highestRecorded(db);
  return highest === undefined || highest.generation <= policy.generation;
};

/** Where a child run sits: its lineage's root, and its depth under it. */
export interface ChildPlace {
  rootRunId: string;
  depth: number;
}

/** A slot of the lineage of `root`, while it `fits`: where it sits, or none. */
const admittedUnkeyed = async (
  db: DrizzleD1Database,
  { root, depth }: { root: string; depth: number },
  policy: QuotaPolicy,
  fits: SQL | undefined
): Promise<ChildPlace | undefined> => {
  const [, taken] = await db.batch([
    lineageCreated(db, root),
    db
      .update(runLineages)
      .set({
        descendants: sql`${runLineages.descendants} + 1`,
        policyGeneration: policy.generation,
      })
      .where(fits)
      .returning({ descendants: runLineages.descendants }),
  ]);
  return taken.length > 0 ? { rootRunId: root, depth } : undefined;
};

/**
 * The child of the trigger key `key`, admitted once: claimed with a slot
 * of the lineage of `root` while it `fits`, in one batch, so deliveries of
 * one message admitted at once, or one after another, are one child in
 * one slot, and none is refused for the slot another took for it. Where
 * it sits, or none.
 */
const admittedKeyed = async (
  db: DrizzleD1Database,
  { root, depth, key }: { root: string; depth: number; key: string },
  policy: QuotaPolicy,
  fits: SQL | undefined
): Promise<ChildPlace | undefined> => {
  const children = runLineageChildren;
  const admitted = await db.batch([
    lineageCreated(db, root),
    // The claim, only while the lineage has room: one statement, so no
    // other admission comes between the check and the claim.
    db
      .insert(children)
      .select(
        sql`SELECT ${key}, ${root}, ${depth}, ${Date.now()} FROM ${runLineages} WHERE ${fits}`
      )
      .onConflictDoNothing(),
    // Its slot, only if that statement claimed it.
    db
      .update(runLineages)
      .set({
        descendants: sql`${runLineages.descendants} + 1`,
        policyGeneration: policy.generation,
      })
      .where(and(eq(runLineages.rootRunId, root), sql`changes() > 0`)),
    db
      .select({ rootRunId: children.rootRunId, depth: children.depth })
      .from(children)
      .where(eq(children.triggerKey, key)),
  ]);
  const {
    3: [claimed],
  } = admitted;
  return claimed;
};

/** `admitChild` under `policy`; `retried` once read again (`policyStill`). */
const admitChildOnce = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  parent: { id: string; rootRunId: string | null; depth: number },
  key: string | undefined,
  policy: QuotaPolicy,
  retried: boolean
): Promise<ChildPlace> => {
  const root = parent.rootRunId ?? parent.id;
  const depth = parent.depth + 1;
  // Depth 0 is the lineage's first level.
  if (depth >= policy.limits.workflowNestingLevels) {
    throw limitReached("nesting", policy);
  }
  const db = drizzle(env.DB);
  const bornAfter = new Date(Date.now() - policy.limits.workflowAgeMs);
  const fits = and(
    eq(runLineages.rootRunId, root),
    lt(runLineages.descendants, policy.limits.workflowDescendantRuns),
    gt(runLineages.createdAt, bornAfter),
    stillCurrent(policy)
  );
  const taken = await (key === undefined
    ? admittedUnkeyed(db, { root, depth }, policy, fits)
    : admittedKeyed(db, { root, depth, key }, policy, fits));
  if (taken !== undefined) {
    return taken;
  }
  if (!retried && !(await policyStill(db, policy))) {
    return await admitChildOnce(env, parent, key, await quotaPolicy(env), true);
  }
  const lineage = await db
    .select({ createdAt: runLineages.createdAt })
    .from(runLineages)
    .where(eq(runLineages.rootRunId, root))
    .get();
  if (lineage === undefined) {
    throw new Error(`No run ${root} to start a run under`);
  }
  throw limitReached(
    lineage.createdAt <= bornAfter ? "age" : "descendants",
    policy
  );
};

/**
 * Admits a run started under `parent` (its row): it sits one deeper than
 * its parent, within the levels a lineage may have, and takes one of the
 * descendant runs its lineage may start, while the lineage is young
 * enough. A run of a trigger's `key` is admitted once: a delivery of it
 * admitted again, at once or later, is the same child, and takes no other
 * slot. Throws `workflow.lineage_limit` past any of them, having taken
 * nothing; a slot taken is never given back.
 */
export const admitChild = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  parent: { id: string; rootRunId: string | null; depth: number },
  key?: string
): Promise<ChildPlace> =>
  await admitChildOnce(env, parent, key, await quotaPolicy(env), false);

/** A step's attempt, as the engine claimed it and its host knows it. */
export interface QuotaAttempt {
  /** Its step's idempotency key in the engine. */
  key: string;
  /**
   * Its step's name, as the run's code named it: its place in the
   * client's queue (admission.ts) is by it, the same for every attempt and
   * every round the step waits.
   */
  step: string;
  /** Its number, from 1, as the engine counts the step's attempts. */
  number: number;
  /**
   * Its step's place among the run's steps (host.ts, `countedStep`): one
   * past the policy's steps is refused, whatever limit the run's
   * activation counted by.
   */
  ordinal?: number;
  /** The generation of the activation that claimed it. */
  generation: number;
  /**
   * The rounds its step has waited for load before it (host.ts): how
   * long it waits this round, should it be refused (admission.ts,
   * `askAgainSeconds`).
   */
  waited?: number;
  /**
   * How long its step has waited for load since its last admission, if it
   * has: its rounds' waits added up, not the time between them (host.ts).
   */
  waitedMs?: number;
  /** When the engine gives up on it (ms since the epoch). */
  deadline: number;
  /**
   * Whether it collects the decided outcome of a connector call held for
   * its person (resource-host.ts, `StepRun.collecting`): the attempt that
   * was held took that call's host calls, so this one takes none, and is
   * admitted though the lineage has none left.
   */
  collecting?: true;
}

/**
 * An admitted attempt: what admits each of its host calls, and what
 * settles it, once its code has returned.
 */
export interface AttemptAdmission {
  /** The attempts the quota policy admits at the step: none after this many. */
  attemptsAllowed: number;
  /**
   * Admits one host call of the attempt against its lineage's
   * (`hostCallsOf`), throwing the refusal.
   */
  hostCall: () => Promise<void>;
  /** Settles it with the time it used and the calls it made; never throws. */
  settle: () => Promise<void>;
}

/** The least wait a refusal for a busy lineage names, in seconds. */
const minRetryAfterSeconds = 1;

/**
 * The seconds until the first of the lineage of `root`'s attempts still
 * holding reaches its deadline, when its hold is given back at the latest
 * (an admission settles it then): at least {@link minRetryAfterSeconds}.
 * What it holds is no sooner given back, since a hold goes only as it
 * settles; one may settle earlier, which the host finds by asking again
 * every minute at most (admission.ts, `askAgainSeconds`).
 */
const busyFor = async (
  db: DrizzleD1Database,
  root: string,
  now: number
): Promise<number> => {
  const held = runLineageAttempts;
  const soonest = await db
    .select({
      ends: sql<number | null>`min(${held.deadline})`,
    })
    .from(held)
    .where(and(eq(held.rootRunId, root), isNull(held.settledAt)))
    .get();
  const ends = soonest?.ends ?? now;
  return Math.max(minRetryAfterSeconds, Math.ceil((ends - now) / 1000));
};

/**
 * Settles the attempt `identity` of the lineage of `root`, admitted at
 * `admittedAt`: its hold is given back, and the lineage counts what it
 * used, the wall time it ran up to its deadline, and gives back the
 * `unusedHostCalls` it reserved and didn't make. Once only, however often
 * it is called, and not at all once its deadline has passed and an
 * admission settled it as used up. Logged, never thrown, when the
 * database can't: the hold stays, and is settled as used up once its
 * deadline has passed.
 */
const settleAttempt = async (
  env: Pick<Env, "DB">,
  root: string,
  identity: ReturnType<typeof and>,
  admittedAt: Date,
  unusedHostCalls: number
): Promise<void> => {
  const held = runLineageAttempts;
  const ran = Math.max(0, Date.now() - admittedAt.getTime());
  const db = drizzle(env.DB);
  const open = and(identity, isNull(held.settledAt));
  const reservedOf = sql`(SELECT ${held.reservedMs} FROM ${held} WHERE ${open})`;
  // What it ran, no further than its deadline.
  const used = sql`min(${ran}, ${held.deadline} - ${held.admittedAt})`;
  const usedOf = sql`(SELECT ${used} FROM ${held} WHERE ${open})`;
  // Settled sooner, as the engine fenced it or its time passed, with its
  // calls not yet given back: they are, once, and its time stays charged.
  const callsOwed = and(
    identity,
    isNotNull(held.settledAt),
    eq(held.callsSettled, false)
  );
  try {
    await db.batch([
      db
        .update(runLineages)
        .set({
          activeHeldMs: sql`${runLineages.activeHeldMs} - ${reservedOf}`,
          activeUsedMs: sql`${runLineages.activeUsedMs} + ${usedOf}`,
          hostCalls: sql`max(0, ${runLineages.hostCalls} - ${unusedHostCalls})`,
        })
        .where(
          and(
            eq(runLineages.rootRunId, root),
            sql`EXISTS (SELECT 1 FROM ${held} WHERE ${open})`
          )
        ),
      db
        .update(held)
        .set({
          usedMs: used,
          settledAt: new Date(),
          hostCalls: sql`max(0, ${held.hostCalls} - ${unusedHostCalls})`,
          callsSettled: true,
        })
        .where(open),
      db
        .update(runLineages)
        .set({
          hostCalls: sql`max(0, ${runLineages.hostCalls} - ${unusedHostCalls})`,
        })
        .where(
          and(
            eq(runLineages.rootRunId, root),
            sql`EXISTS (SELECT 1 FROM ${held} WHERE ${callsOwed})`
          )
        ),
      db
        .update(held)
        .set({
          hostCalls: sql`max(0, ${held.hostCalls} - ${unusedHostCalls})`,
          callsSettled: true,
        })
        .where(callsOwed),
    ]);
  } catch (error) {
    log.error("workflow.attempt_settle_failed", {
      root,
      ...errorFields(error),
    });
  }
};

/**
 * Refusals of host calls made under the policy still current as they were
 * made: only these an attempt keeps giving (`hostCallsOf`), as a later
 * policy may allow what an older one refused.
 */
const spentUnderCurrent = new WeakSet<Error>();

/** The most host calls an attempt reserves of its lineage at once. */
const hostCallBlockMax = 32;

/**
 * Reserves up to `block` host calls of the lineage of `root` for its
 * attempt `identity`, under `policy`: no more than the lineage has left,
 * and none once the attempt has settled. Answers how many it reserved, at
 * least one; throws `workflow.lineage_limit` when the lineage has none
 * left, or `execution.stale_attempt` for a settled attempt.
 */
const reserveHostCallsOnce = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  lineage: { root: string; identity: ReturnType<typeof and> },
  block: number,
  policy: QuotaPolicy,
  retried: boolean
): Promise<number> => {
  const { root, identity } = lineage;
  const db = drizzle(env.DB);
  const held = runLineageAttempts;
  const limit = policy.limits.lineageHostCalls;
  const ofLineage = eq(runLineages.rootRunId, root);
  const grant = sql`min(${block}, ${limit} - ${runLineages.hostCalls})`;
  // One batch, so one transaction: what the lineage had before is what
  // both updates grant from, and no other reservation comes between.
  const [before, granted] = await db.batch([
    db
      .select({ hostCalls: runLineages.hostCalls })
      .from(runLineages)
      .where(ofLineage),
    // The attempt's receipt first, while it is open and the lineage has
    // calls left under a policy still current...
    db
      .update(held)
      .set({
        hostCalls: sql`${held.hostCalls} + (SELECT ${grant} FROM ${runLineages} WHERE ${ofLineage})`,
      })
      .where(
        and(
          identity,
          isNull(held.settledAt),
          sql`EXISTS (SELECT 1 FROM ${runLineages} WHERE ${ofLineage} AND ${runLineages.hostCalls} < ${limit} AND ${stillCurrent(policy)})`
        )
      )
      .returning({ hostCalls: held.hostCalls }),
    // ...then the lineage, by as much, only if that took.
    db
      .update(runLineages)
      .set({
        hostCalls: sql`${runLineages.hostCalls} + ${grant}`,
        policyGeneration: policy.generation,
      })
      .where(
        and(ofLineage, lt(runLineages.hostCalls, limit), sql`changes() > 0`)
      ),
  ]);
  const had = before[0]?.hostCalls;
  if (had === undefined) {
    throw new Error(`No run ${root} to count host calls of`);
  }
  if (granted.length > 0) {
    return Math.min(block, limit - had);
  }
  // Refused: by the policy as it is now, never by one an operator has
  // changed since it was read (a limit raised meanwhile admits the call).
  const still = await policyStill(db, policy);
  if (!still && !retried) {
    return await reserveHostCallsOnce(
      env,
      lineage,
      block,
      await quotaPolicy(env),
      true
    );
  }
  if (had >= limit) {
    const refusal = limitReached("hostCalls", policy);
    if (still) {
      spentUnderCurrent.add(refusal);
    }
    throw refusal;
  }
  throw executionErrors.create("execution.stale_attempt");
};

/**
 * The host calls of the attempt `identity`, of the lineage of `root`, as
 * its host admits them: `take` admits one, from what the attempt reserved
 * of the lineage, reserving another block when that is used up (one at a
 * time: calls made at once wait for the same block). Blocks start at one
 * call and double, up to {@link hostCallBlockMax}, so an attempt that
 * makes few calls reserves few, and one that makes many writes once every
 * few dozen. `close` ends it as the attempt settles: no call is admitted
 * after it, and once a reservation still in flight has landed, it answers
 * what the attempt reserved and didn't use, that block included, for its
 * settle to give back. Once the lineage has none left, every later call of
 * the attempt is refused here, without asking the database again: a step
 * that catches the refusal in a loop costs nothing more.
 *
 * What an attempt reserved and hasn't used yet is the lineage's no more
 * until it settles: near the limit, a sibling attempt may be refused while
 * calls are still left over in another's block. That errs on the safe
 * side, as the lineage never makes more than it may.
 */
const hostCallsOf = (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  root: string,
  identity: ReturnType<typeof and>
): { take: () => Promise<void>; close: () => Promise<number> } => {
  let reserved = 0;
  let used = 0;
  let closed = false;
  /** The lineage's refusal, once it had no calls left: given again. */
  let exhausted: Error | undefined;
  let reserving: Promise<void> | undefined;
  const reserve = async (): Promise<void> => {
    try {
      const block = Math.min(hostCallBlockMax, Math.max(1, reserved));
      const granted = await reserveHostCallsOnce(
        env,
        { root, identity },
        block,
        await quotaPolicy(env),
        false
      );
      // A grant of none would have `take` ask again without end.
      if (!Number.isInteger(granted) || granted < 1) {
        throw new Error(`A reservation granted ${String(granted)} host calls`);
      }
      reserved += granted;
    } catch (error) {
      if (error instanceof Error && spentUnderCurrent.has(error)) {
        exhausted = error;
      }
      throw error;
    } finally {
      reserving = undefined;
    }
  };
  return {
    take: async () => {
      for (;;) {
        if (closed) {
          throw executionErrors.create("execution.stale_attempt");
        }
        if (exhausted !== undefined) {
          throw exhausted;
        }
        if (used < reserved) {
          used += 1;
          return;
        }
        reserving ??= reserve();
        // oxlint-disable-next-line no-await-in-loop -- one block at a time
        await reserving;
      }
    },
    close: async () => {
      closed = true;
      // A block a call left reserving lands, or fails, before the count:
      // one counted before it landed would never be given back.
      try {
        await reserving;
      } catch {
        // Refused or failed: it reserved nothing.
      }
      return reserved - used;
    },
  };
};

/**
 * The statements that settle, at `now`, the unsettled attempts `dead`
 * picks (SQL over `run_lineage_attempts`), which the engine has fenced:
 * they hold nothing more, so their shares of the attempts running at once
 * come free (admission.ts), and each used what it ran, up to its
 * deadline. Their lineages count that, and hold their allowance no more.
 * An attempt settles once: one settled already, as it returned or as its
 * time passed, is left as it is.
 */
const fencedSettled = (
  db: DrizzleD1Database,
  dead: SQL,
  now: number,
  toDeadline: SQL = sql`0`
) => {
  const held = runLineageAttempts;
  const open = sql`${held.settledAt} IS NULL AND ${dead}`;
  // What it ran, or, `toDeadline`, all it could: its deadline less its
  // admission.
  const used = sql`CASE WHEN ${toDeadline} THEN ${held.deadline} - ${held.admittedAt} ELSE min(${held.deadline}, ${now}) - ${held.admittedAt} END`;
  // Each lineage by its own attempts: in the subquery, the attempts'
  // columns are its table's, the lineage's the row being updated.
  const sumOf = (of: SQL) =>
    sql`(SELECT coalesce(sum(${of}), 0) FROM ${held} WHERE ${open} AND ${held.rootRunId} = run_lineages.root_run_id)`;
  return [
    db
      .update(runLineages)
      .set({
        activeUsedMs: sql`${runLineages.activeUsedMs} + ${sumOf(used)}`,
        activeHeldMs: sql`${runLineages.activeHeldMs} - ${sumOf(sql`${held.reservedMs}`)}`,
      })
      .where(
        sql`${runLineages.rootRunId} IN (SELECT ${held.rootRunId} FROM ${held} WHERE ${open})`
      ),
    db
      .update(held)
      .set({ usedMs: used, settledAt: new Date(now) })
      .where(open),
  ] as const;
};

/**
 * Gives back what the attempts of run `run` of activation generation
 * `through`, or an older one, still hold: the engine has fenced them (its
 * object says so, run-object.ts, `generationOver`), so they hold no share
 * of the attempts running at once, nor any of their lineage's active time,
 * whatever their code still does. Each used what it ran, up to its
 * deadline; of a run cancelled (`cancelled`, its object's mark, or its
 * tombstone), all it could, up to its deadline: the engine stops a
 * cancelled attempt's calls, not its isolate, whose computation may run
 * on until then. Its share still comes back now: the attempt can act on
 * nothing, and holding the share would keep others from theirs for
 * computation no one waits on. In the same transaction, the run's row
 * records the fence
 * (`shares_fenced_through`): an attempt of those generations whose
 * admission lands later takes nothing (`admitAttemptOnce`).
 *
 * Only `run`'s attempts, and only of generations the engine fenced:
 * `through` only grows, so a call however late, or made again, gives back
 * nothing a newer activation's attempt holds, and nothing twice. Throws
 * when the database can't, for the engine to hand the notification over
 * again.
 */
export const sharesReleased = async (
  env: Pick<Env, "DB">,
  run: string,
  through: number,
  { cancelled }: { cancelled: boolean }
): Promise<void> => {
  const db = drizzle(env.DB);
  const held = runLineageAttempts;
  await db.batch([
    ...fencedSettled(
      db,
      sql`${held.runId} = ${run} AND ${held.generation} <= ${through}`,
      Date.now(),
      cancelled ? sql`1` : cancelledRun(run)
    ),
    ...fenceRecorded(db, run, through),
  ]);
};

/** Whose run an attempt is: its lineage, who it acts for and its App. */
export interface AttemptOwner extends AdmissionScope {
  run: string;
  root: string;
}

/**
 * That the lineage has host calls left for `attempt`, as SQL of its row:
 * always, for one that collects a held call's outcome (`collecting`),
 * which takes none.
 */
const hostCallsLeftSql = (attempt: QuotaAttempt, policy: QuotaPolicy): SQL =>
  attempt.collecting === true
    ? sql`1`
    : sql`${runLineages.hostCalls} < ${policy.limits.lineageHostCalls}`;

/** Whether the lineage, having made `made`, has none left for `attempt`. */
const outOfHostCalls = (
  attempt: QuotaAttempt,
  made: number,
  policy: QuotaPolicy
): boolean =>
  attempt.collecting !== true && made >= policy.limits.lineageHostCalls;

/** `admitAttempt` under `policy`; `retried` once read again (`policyStill`). */
const admitAttemptOnce = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  owner: AttemptOwner,
  attempt: QuotaAttempt,
  policy: QuotaPolicy,
  retried: boolean
): Promise<AttemptAdmission> => {
  // The run's steps, by the policy as it is now: the limit an activation
  // counts by may be a fallback while the policy couldn't be read
  // (host.ts, `stepLimitOf`), and lets the run load, never admits work
  // past the live one.
  if (
    attempt.ordinal !== undefined &&
    attempt.ordinal > policy.limits.workflowSteps
  ) {
    throw limitReached("steps", policy);
  }
  if (attempt.number > policy.limits.workflowAttemptsPerStep) {
    throw workflowErrors.create("workflow.too_many_attempts", {
      max: policy.limits.workflowAttemptsPerStep,
      generation: policy.generation,
    });
  }
  const now = Date.now();
  // An attempt already past its deadline would hold nothing, and the
  // engine has given up on it: it is stale, whatever it still does.
  if (attempt.deadline <= now) {
    throw executionErrors.create("execution.stale_attempt");
  }
  // Waited for load as long as a step may, by the policy as it is now,
  // whatever cap the step waited under: it fails before taking a lease,
  // so none of its code runs.
  if (
    attempt.waitedMs !== undefined &&
    attempt.waitedMs >= policy.limits.workflowQueuedStepMs
  ) {
    throw workflowErrors.create("workflow.queue_timeout", {
      maxWaitMs: policy.limits.workflowQueuedStepMs,
    });
  }
  const { run, root } = owner;
  const db = drizzle(env.DB);
  const shares = sharesOf(policy);
  const place = await queuePlaceOf(run, attempt.step, attempt.deadline);
  const standing = await standingOf(db, owner, place, now);
  const reserved = Math.min(
    attempt.deadline - now,
    platformLimits.workflowAttemptWallMs
  );
  const bornAfter = now - policy.limits.workflowAgeMs;
  const held = runLineageAttempts;
  const identity = and(
    eq(held.runId, run),
    eq(held.stepKey, attempt.key),
    eq(held.attempt, attempt.number),
    eq(held.generation, attempt.generation)
  );
  const receiptHeld = sql`EXISTS (SELECT 1 FROM ${held} WHERE ${and(identity, isNull(held.settledAt))})`;
  // The lineage's attempts past their deadline, unsettled: they used all
  // they could.
  const lapsed = sql`${held.rootRunId} = ${root} AND ${held.settledAt} IS NULL AND ${held.deadline} <= ${now}`;
  const lapsedSum = (of: SQL) =>
    sql`(SELECT coalesce(sum(${of}), 0) FROM ${held} WHERE ${lapsed})`;
  // An attempt of an activation the engine has fenced takes no share:
  // the run was cancelled (its tombstone), its object said its attempts
  // of this generation hold no more (`sharesReleased`), or a newer
  // activation's attempt was admitted. However late its call lands.
  const fencedOut = sql`(${fencedRun(run, attempt.generation)} OR EXISTS (SELECT 1 FROM ${held} WHERE ${held.runId} = ${run} AND ${held.generation} > ${attempt.generation}))`;
  const hostCallsLeft = hostCallsLeftSql(attempt, policy);
  const written = await db.batch([
    lineageCreated(db, root),
    db
      .update(runLineages)
      .set({
        activeUsedMs: sql`${runLineages.activeUsedMs} + ${lapsedSum(sql`${held.deadline} - ${held.admittedAt}`)}`,
        activeHeldMs: sql`${runLineages.activeHeldMs} - ${lapsedSum(sql`${held.reservedMs}`)}`,
      })
      .where(eq(runLineages.rootRunId, root)),
    db
      .update(held)
      .set({
        usedMs: sql`${held.deadline} - ${held.admittedAt}`,
        settledAt: new Date(now),
      })
      .where(lapsed),
    // The run's attempts the engine claimed for an activation that is over
    // (a lower generation): this one's activation took the run over, so
    // they hold nothing more, whichever step they were of.
    ...fencedSettled(
      db,
      sql`${held.runId} = ${run} AND ${held.generation} < ${attempt.generation}`,
      now
    ),
    // And it records that fence, whether or not it takes a lease: an
    // older activation's admission landing after this one, of any step,
    // takes none of what it gave back. A takeover changes no status, so
    // no notification records it.
    ...fenceRecorded(db, run, attempt.generation - 1),
    ...queuePruned(db, now),
    // The receipt, which is also the attempt's lease on its shares of the
    // attempts running at once (admission.ts), only while the lineage has
    // time left and is young enough, and every share has room: one
    // statement, so no other admission comes between the check and the
    // hold.
    db
      .insert(held)
      .select(
        sql`SELECT ${run}, ${attempt.key}, ${attempt.number}, ${attempt.generation}, ${root}, ${reserved}, ${attempt.deadline}, NULL, ${now}, NULL, ${policy.generation}, 0, ${owner.subject}, ${owner.resource}, ${place.stepHash}, 0 FROM ${runLineages} WHERE ${runLineages.rootRunId} = ${root} AND NOT ${fencedOut} AND ${runLineages.activeUsedMs} + ${runLineages.activeHeldMs} < ${policy.limits.workflowActiveMs} AND ${hostCallsLeft} AND ${runLineages.createdAt} > ${bornAfter} AND ${stillCurrent(policy)} AND ${roomFor(attemptPool, owner, place, standing, now, shares)}`
      )
      .onConflictDoNothing(),
    // Held on the lineage only if that statement took the receipt.
    db
      .update(runLineages)
      .set({
        activeHeldMs: sql`${runLineages.activeHeldMs} + ${reserved}`,
        policyGeneration: policy.generation,
      })
      .where(and(eq(runLineages.rootRunId, root), sql`changes() > 0`)),
    // Admitted, it waits in the queue no more.
    ...dequeued(db, place, receiptHeld),
    // Refused, why: the shares as that statement found them, in the same
    // transaction; nothing counted once it is admitted.
    sharesRead(db, owner, place, standing, now, shares, receiptHeld),
  ]);
  const sharesFound = written.at(-1);
  // Read once the batch is in: a receipt still holding was admitted, by
  // this call or by an earlier one of the attempt. One that has settled
  // (the attempt returned, or its allowance passed and an admission
  // settled it as used up) admits nothing more: the attempt is over.
  const [receipts, lineages, fencedRuns] = await db.batch([
    db
      .select({ admittedAt: held.admittedAt, settledAt: held.settledAt })
      .from(held)
      .where(identity),
    db
      .select({
        createdAt: runLineages.createdAt,
        used: runLineages.activeUsedMs,
        hostCalls: runLineages.hostCalls,
        held: runLineages.activeHeldMs,
      })
      .from(runLineages)
      .where(eq(runLineages.rootRunId, root)),
    db
      .select({ fenced: sql<number>`1` })
      .from(runLineages)
      .where(and(eq(runLineages.rootRunId, root), fencedOut)),
  ]);
  const [admitted] = receipts;
  if (admitted !== undefined) {
    if (admitted.settledAt !== null) {
      throw executionErrors.create("execution.stale_attempt");
    }
    const hostCalls = hostCallsOf(env, root, identity);
    return {
      attemptsAllowed: policy.limits.workflowAttemptsPerStep,
      hostCall: hostCalls.take,
      settle: async () => {
        await settleAttempt(
          env,
          root,
          identity,
          admitted.admittedAt,
          await hostCalls.close()
        );
      },
    };
  }
  // Fenced, it is over: it waits for no share, and takes none.
  if (fencedRuns.length > 0) {
    throw executionErrors.create("execution.stale_attempt");
  }
  if (!retried && !(await policyStill(db, policy))) {
    return await admitAttemptOnce(
      env,
      owner,
      attempt,
      await quotaPolicy(env),
      true
    );
  }
  const [found] = lineages;
  if (found === undefined) {
    throw new Error(`No run ${root} to admit an attempt of`);
  }
  if (found.createdAt.getTime() <= bornAfter) {
    throw limitReached("age", policy);
  }
  // A lineage with no host calls left admits no attempt: its calls would
  // all be refused, and a step catching them would only spin. But for one
  // collecting a held call's outcome, which takes none.
  if (outOfHostCalls(attempt, found.hostCalls, policy)) {
    throw limitReached("hostCalls", policy);
  }
  if (found.used >= policy.limits.workflowActiveMs) {
    throw limitReached("activeTime", policy);
  }
  if (found.used + found.held >= policy.limits.workflowActiveMs) {
    throw workflowErrors.create("workflow.lineage_busy", {
      retryAfterSeconds: await busyFor(db, root, now),
      maxWaitMs: policy.limits.workflowQueuedStepMs,
    });
  }
  // The lineage had room: the client's shares hadn't, as the batch that
  // refused it read them.
  throw await queuedRefusal(db, owner, place, now, shares, sharesFound, {
    waited: attempt.waited ?? 0,
    waitedMs: attempt.waitedMs ?? 0,
    maxWaitMs: policy.limits.workflowQueuedStepMs,
  });
};

/**
 * Gives up `place`, unless a newer attempt of its step wrote it since
 * (admission.ts, `dequeued`): the step waits for something other than a
 * share now. What the call was refused for is thrown whether or not this
 * lands: a place left behind lapses (`queueLiveMs`).
 */
const placeGivenUp = async (
  db: DrizzleD1Database,
  owner: AttemptOwner,
  place: QueuePlace
): Promise<void> => {
  try {
    await db.batch(dequeued(db, place, sql`1 = 1`));
  } catch (error) {
    log.warn("workflow.queue.give_up_failed", {
      runId: owner.run,
      ...errorFields(error),
    });
  }
};

/**
 * Admits `attempt` of a step of `run`, of the lineage of `root`: within
 * the attempts a step may have, while the lineage is young enough and its
 * attempts haven't used, or don't hold, all of its active time, and while
 * the client's attempts running at once leave it a share, in all, for the
 * person the run acts for and of its App, after those queued before it
 * (admission.ts). Admitted,
 * it holds its allowance (its deadline less now, at most a minute) until
 * it settles;
 * the same attempt admitted again holds once, until it settles. Throws,
 * having held nothing, `execution.stale_attempt` for an attempt past its
 * deadline or already settled, `workflow.too_many_attempts`,
 * `workflow.lineage_limit` (active time or age), or
 * `workflow.lineage_busy` with the seconds after which an attempt under
 * way will have given back its hold, or `workflow.queued`, having queued
 * it, with the share it waits for and the seconds after which that share
 * comes free at the latest (admission.ts, `waitOf`). Any other refusal gives up the step's place in
 * the queue, unless a newer attempt of the step wrote it (`placeGivenUp`).
 */
export const admitAttempt = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  owner: AttemptOwner,
  attempt: QuotaAttempt
): Promise<AttemptAdmission> => {
  try {
    return await admitAttemptOnce(
      env,
      owner,
      attempt,
      await quotaPolicy(env),
      false
    );
  } catch (error) {
    // Queued, it keeps its place.
    if (workflowErrors.codeOf(error) !== "workflow.queued") {
      const db = drizzle(env.DB);
      await placeGivenUp(
        db,
        owner,
        await queuePlaceOf(owner.run, attempt.step, attempt.deadline)
      );
    }
    throw error;
  }
};
