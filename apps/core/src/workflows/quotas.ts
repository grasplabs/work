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
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  quotaPolicies,
  runLineageAttempts,
  runLineageChildren,
  runLineages,
  workflowRuns,
} from "../db/core/schema.ts";

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
 * root's start. Nothing for a run core has no row of.
 */
export const lineageCreated = (db: DrizzleD1Database, root: string) =>
  db
    .insert(runLineages)
    .select(
      sql`SELECT ${workflowRuns.id}, ${workflowRuns.createdAt}, 0, 0, 0, 0 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${root}`
    )
    .onConflictDoNothing();

/**
 * That `policy`'s generation is still the highest `quota_policies`
 * recorded, as SQL: a condition of each admission's statement, so a
 * policy read just before a newer generation was recorded admits nothing
 * under it (`policyStill`).
 */
const stillCurrent = (policy: QuotaPolicy): SQL =>
  sql`${policy.generation} >= coalesce((SELECT max(${quotaPolicies.generation}) FROM ${quotaPolicies}), 0)`;

/**
 * Whether `policy` is still the one to admit by: no higher generation was
 * recorded since it was read. One that isn't is read again, and the
 * admission tried again under it, once.
 */
const policyStill = async (
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
  /** When the engine gives up on it (ms since the epoch). */
  deadline: number;
}

/** An admitted attempt: what settles it, once its code has returned. */
export interface AttemptAdmission {
  /** The attempts the quota policy admits at the step: none after this many. */
  attemptsAllowed: number;
  /** Settles it with the time it used; never throws. */
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
 * every few seconds at most (host.ts, `maxBusyWaitSeconds`).
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
 * used, the wall time it ran up to its deadline. Once only, however often
 * it is called, and not at all once its deadline has passed and an
 * admission settled it as used up. Logged, never thrown, when the
 * database can't: the hold stays, and is settled as used up once its
 * deadline has passed.
 */
const settleAttempt = async (
  env: Pick<Env, "DB">,
  root: string,
  identity: ReturnType<typeof and>,
  admittedAt: Date
): Promise<void> => {
  const held = runLineageAttempts;
  const ran = Math.max(0, Date.now() - admittedAt.getTime());
  const db = drizzle(env.DB);
  const open = and(identity, isNull(held.settledAt));
  const reservedOf = sql`(SELECT ${held.reservedMs} FROM ${held} WHERE ${open})`;
  // What it ran, no further than its deadline.
  const used = sql`min(${ran}, ${held.deadline} - ${held.admittedAt})`;
  const usedOf = sql`(SELECT ${used} FROM ${held} WHERE ${open})`;
  try {
    await db.batch([
      db
        .update(runLineages)
        .set({
          activeHeldMs: sql`${runLineages.activeHeldMs} - ${reservedOf}`,
          activeUsedMs: sql`${runLineages.activeUsedMs} + ${usedOf}`,
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
        })
        .where(open),
    ]);
  } catch (error) {
    log.error("workflow.attempt_settle_failed", {
      root,
      ...errorFields(error),
    });
  }
};

/** `admitAttempt` under `policy`; `retried` once read again (`policyStill`). */
const admitAttemptOnce = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  { run, root }: { run: string; root: string },
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
  const db = drizzle(env.DB);
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
  // The lineage's attempts past their deadline, unsettled: they used all
  // they could.
  const lapsed = sql`${held.rootRunId} = ${root} AND ${held.settledAt} IS NULL AND ${held.deadline} <= ${now}`;
  const lapsedSum = (of: SQL) =>
    sql`(SELECT coalesce(sum(${of}), 0) FROM ${held} WHERE ${lapsed})`;
  await db.batch([
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
    // The receipt, only while the lineage has time left and is young
    // enough: one statement, so no other admission comes between the
    // check and the hold.
    db
      .insert(held)
      .select(
        sql`SELECT ${run}, ${attempt.key}, ${attempt.number}, ${attempt.generation}, ${root}, ${reserved}, ${attempt.deadline}, NULL, ${now}, NULL, ${policy.generation} FROM ${runLineages} WHERE ${runLineages.rootRunId} = ${root} AND ${runLineages.activeUsedMs} + ${runLineages.activeHeldMs} < ${policy.limits.workflowActiveMs} AND ${runLineages.createdAt} > ${bornAfter} AND ${stillCurrent(policy)}`
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
  ]);
  // Read once the batch is in: a receipt still holding was admitted, by
  // this call or by an earlier one of the attempt. One that has settled
  // (the attempt returned, or its allowance passed and an admission
  // settled it as used up) admits nothing more: the attempt is over.
  const [receipts, lineages] = await db.batch([
    db
      .select({ admittedAt: held.admittedAt, settledAt: held.settledAt })
      .from(held)
      .where(identity),
    db
      .select({
        createdAt: runLineages.createdAt,
        used: runLineages.activeUsedMs,
      })
      .from(runLineages)
      .where(eq(runLineages.rootRunId, root)),
  ]);
  const [admitted] = receipts;
  if (admitted !== undefined) {
    if (admitted.settledAt !== null) {
      throw executionErrors.create("execution.stale_attempt");
    }
    return {
      attemptsAllowed: policy.limits.workflowAttemptsPerStep,
      settle: async () => {
        await settleAttempt(env, root, identity, admitted.admittedAt);
      },
    };
  }
  if (!retried && !(await policyStill(db, policy))) {
    return await admitAttemptOnce(
      env,
      { run, root },
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
  if (found.used >= policy.limits.workflowActiveMs) {
    throw limitReached("activeTime", policy);
  }
  throw workflowErrors.create("workflow.lineage_busy", {
    retryAfterSeconds: await busyFor(db, root, now),
  });
};

/**
 * Admits `attempt` of a step of `run`, of the lineage of `root`: within
 * the attempts a step may have, while the lineage is young enough and its
 * attempts haven't used, or don't hold, all of its active time. Admitted,
 * it holds its allowance (its deadline less now, at most a minute) until
 * it settles;
 * the same attempt admitted again holds once, until it settles. Throws,
 * having held nothing, `execution.stale_attempt` for an attempt past its
 * deadline or already settled, `workflow.too_many_attempts`,
 * `workflow.lineage_limit` (active time or age), or
 * `workflow.lineage_busy` with the seconds after which an attempt under
 * way will have given back its hold.
 */
export const admitAttempt = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  lineage: { run: string; root: string },
  attempt: QuotaAttempt
): Promise<AttemptAdmission> =>
  await admitAttemptOnce(env, lineage, attempt, await quotaPolicy(env), false);
