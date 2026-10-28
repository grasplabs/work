import type { AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { coreStartKeyPrefix } from "@grasp-os/shared/workflow-resources";
import { maxFailedStarts } from "@grasp-os/shared/workflows";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "../audit-outbox.ts";
import {
  triggerResources,
  triggerResourceVersions,
  triggerSchedules,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { stopNoticed } from "../notifications.ts";
import { nextOccurrence } from "../trigger-resources.ts";
import { isStaleRefusal, startWorkflow } from "../workflow-starts.ts";

// Starting the runs of independent schedule triggers (platform
// specification 15.1, 15.2; trigger-resources.ts) from core's clock, every
// minute (`startDueScheduleTriggers`). Each trigger keeps its next
// occurrence in `trigger_schedules`; a run starts first, then the next
// occurrence is written, only over the one read. Threat model, and how
// each is closed:
//
// - An occurrence starting its run twice: two clock runs at once, a lost
//   answer, a clock killed between the start and writing the next
//   occurrence. Each start is keyed by the concrete occurrence, the
//   instant in UTC, under the trigger and its version (`startKeyOf`), and
//   a start's receipt is one per trigger, person and key
//   (workflow-starts.ts): the same occurrence started again is the same
//   start, its run the same run, whatever became of it. A run cancelled
//   since stays cancelled.
// - A schedule acting on authority it lost. Each start is a trigger's
//   start as any other (workflow-starts.ts): the trigger live, enabled
//   and pinning that version, its person still with a role, and its own
//   `start` grant active, all read again in the statement that admits it.
//   A start refused for good is audited (`trigger.schedule.refused`) and
//   the schedule goes on from its next occurrence. Only the refusals named
//   in `refusedForGood` are taken as for good; anything else, an error
//   core doesn't know included, is tried again for the same occurrence,
//   so a new kind of failure never drops an occurrence silently.
// - A schedule that keeps failing, spinning. Each failed try of an
//   occurrence waits twice as long as the one before, up to an hour,
//   counted from the last failed try (`tryNow`), so an occurrence long
//   overdue still waits. Refusals for good and failures in the workflow's own
//   terms (a full run limit, say) count toward stopping it: after
//   `maxFailedStarts` in a row it stops, keeping no next occurrence,
//   audited once (`trigger.schedule.stopped`), and its owner is told
//   (notifications.ts), until they enable it again (whether or not it was
//   disabled) or move it to another version. Core's own failures (its
//   database away, a decision gone stale as it was admitted) never count:
//   an outage of core's stops no schedule, it only delays it.
// - A backlog after an outage. Occurrences missed while the clock didn't
//   run start one run, for the first of them (spec 15.2, `coalesce`), and
//   the schedule goes on from its next occurrence after now.
// - A time that never was, or was twice. A local time the spring change
//   skips starts nothing; one the autumn change repeats starts once, at
//   the first (earlier) instant (`nextOccurrence`). That holds for every
//   expression: a schedule fires once per local wall-clock time it names,
//   so in the repeated hour `*/30` fires at 2:00 and 2:30 once each (in
//   summer time), not four times, and `0 *` fires at 2:00 once.
// - A disabled, deleted or moved trigger starting its old occurrences.
//   Only a live, enabled trigger whose current version is the one its
//   schedule was worked out for is read as due; enabling or moving it
//   works out its next occurrence again, from then, so what it missed
//   meanwhile starts nothing. Two clock runs trying one occurrence at once
//   can't count it failed once either has started it: a failure is
//   recorded only while no start of it was admitted (`unadmitted`), and
//   moving on after a start writes over the occurrence whatever its
//   counts (`sameOccurrence`). A start read before such a change and
//   admitted after it is fenced on the occurrence still being the
//   schedule's next (`stillNext`), so it starts nothing either.

/** Most due schedules one clock run starts; the rest start a minute later. */
const schedulesPerRun = 50;

const minuteMs = 60_000;

/**
 * The refusals of a start taken as for good: the schedule goes on from its
 * next occurrence. `start_denied` is a trigger whose person left or lost
 * their role, whose `start` grant was revoked, or whose workflow is gone;
 * `start_invalid` an input the version no longer takes; `packages_revoked`
 * an approval of the version's packages withdrawn. A trigger disabled,
 * deleted or moved meanwhile (`trigger_unavailable`) is read as due no
 * more, so it is let be.
 */
const refusedForGood: ReadonlySet<string> = new Set([
  "workflow.start_denied",
  "workflow.start_invalid",
  "workflow.packages_revoked",
]);

/** The most times a failed try's wait doubles: 2^6 minutes, capped at an hour. */
const maxBackoffDoublings = 6;

/** A due schedule trigger, as its current version pins it. */
interface DueSchedule {
  triggerId: string;
  version: number;
  ownerId: string;
  nextAt: Date;
  failedStarts: number;
  attempts: number;
  workflowId: string;
  workflowVersion: number;
  cron: string;
  timeZone: string;
  input: string;
}

/** The start key of trigger version `schedule`'s occurrence at its `nextAt`. */
const startKeyOf = (schedule: DueSchedule): string =>
  `${coreStartKeyPrefix}schedule:${schedule.triggerId}:${schedule.version}:${schedule.nextAt.toISOString()}`;

/** The longest a failed try waits before the next, in minutes. */
const maxBackoffMinutes = 60;

/**
 * That a due schedule may be tried now: at once when no try of its
 * occurrence has failed, and after `n` failed ones, 2^(n-1) minutes after
 * the last of them failed, up to an hour. From the last failure, never
 * from the occurrence: one long overdue (after an outage) still waits.
 */
const tryNow = (now: Date) =>
  sql`(${triggerSchedules.attempts} = 0 OR ${triggerSchedules.lastAttemptAt} IS NULL OR ${triggerSchedules.lastAttemptAt} + MIN(1 << MIN(${triggerSchedules.attempts} - 1, ${maxBackoffDoublings}), ${maxBackoffMinutes}) * ${minuteMs} <= ${now.getTime()})`;

/** That `schedule` is still as it was read, as SQL. */
const asRead = (schedule: DueSchedule) =>
  and(
    eq(triggerSchedules.triggerId, schedule.triggerId),
    eq(triggerSchedules.version, schedule.version),
    eq(triggerSchedules.nextAt, schedule.nextAt),
    eq(triggerSchedules.failedStarts, schedule.failedStarts),
    eq(triggerSchedules.attempts, schedule.attempts)
  );

/**
 * That no start of `schedule`'s occurrence was admitted, as SQL: another
 * clock run's try of the same occurrence may have started it while this
 * one's failed, and a started occurrence is never counted as failing.
 */
const unadmitted = (schedule: DueSchedule) =>
  sql`NOT EXISTS (SELECT 1 FROM ${workflowStartReceipts} WHERE ${workflowStartReceipts.invokerType} = 'trigger' AND ${workflowStartReceipts.invokerId} = ${schedule.triggerId} AND ${workflowStartReceipts.idempotencyKey} = ${startKeyOf(schedule)})`;

/**
 * That `schedule`'s occurrence is still the one due, whatever its counts,
 * as SQL: what moving on after its start writes over, so a failed try of
 * it recorded meanwhile can't keep it from moving on.
 */
const sameOccurrence = (schedule: DueSchedule) =>
  and(
    eq(triggerSchedules.triggerId, schedule.triggerId),
    eq(triggerSchedules.version, schedule.version),
    eq(triggerSchedules.nextAt, schedule.nextAt)
  );

/** That `schedule`'s occurrence is still its trigger's next, as SQL. */
const stillNext = (schedule: DueSchedule) =>
  sql`EXISTS (SELECT 1 FROM ${triggerSchedules} WHERE ${triggerSchedules.triggerId} = ${schedule.triggerId} AND ${triggerSchedules.version} = ${schedule.version} AND ${triggerSchedules.nextAt} = ${schedule.nextAt.getTime()})`;

const systemEntry = (
  schedule: DueSchedule,
  action: string,
  detail: AuditEntry["detail"]
): AuditEntry => ({
  actor: { type: "system" },
  action,
  target: { type: "trigger", id: schedule.triggerId },
  detail: { version: schedule.version, ...detail },
});

/**
 * What a failed start of an occurrence was: refused for good (with its
 * code), a failure in the workflow's own terms, or core's own.
 */
type Failure =
  | { kind: "refused"; code: string }
  | { kind: "failed" }
  | { kind: "core" };

/**
 * Records a failed start of `schedule`'s occurrence, only over the
 * schedule read, so one try counts once. Refused for good, audited, it
 * goes on from its next occurrence after `now`; otherwise the same
 * occurrence stays due, tried again later. Refusals and the workflow's
 * own failures count: at `maxFailedStarts` it stops, audited once, its
 * owner told. Core's own failures only back off.
 */
const recordFailure = async (
  env: Env,
  schedule: DueSchedule,
  now: Date,
  failure: Failure
): Promise<void> => {
  const failedStarts =
    failure.kind === "core" ? schedule.failedStarts : schedule.failedStarts + 1;
  const stops = failure.kind !== "core" && failedStarts >= maxFailedStarts;
  let nextAt: Date | null = schedule.nextAt;
  let attempts = schedule.attempts + 1;
  let lastAttemptAt: Date | null = now;
  if (stops) {
    nextAt = null;
  } else if (failure.kind === "refused") {
    nextAt = nextOccurrence(schedule.cron, schedule.timeZone, now) ?? null;
    attempts = 0;
    lastAttemptAt = null;
  }
  const db = drizzle(env.DB);
  // Each entry only if the update changed: `changes()` reads the statement
  // just before, the update or an entry written only after it.
  await auditedBatch(env, db, [
    db
      .update(triggerSchedules)
      .set({ nextAt, failedStarts, attempts, lastAttemptAt })
      .where(and(asRead(schedule), unadmitted(schedule))),
    ...(failure.kind === "refused"
      ? [
          outboxedIfChanged(
            db,
            systemEntry(schedule, "trigger.schedule.refused", {
              scheduledAt: schedule.nextAt.toISOString(),
              code: failure.code,
            })
          ),
        ]
      : []),
    ...(stops
      ? [
          outboxedIfChanged(
            db,
            systemEntry(schedule, "trigger.schedule.stopped", {
              failedStarts,
            })
          ),
          stopNoticed(db, {
            triggerId: schedule.triggerId,
            workflowId: schedule.workflowId,
            personId: schedule.ownerId,
            recorded: sql`changes() > 0`,
          }),
        ]
      : []),
  ]);
};

/** What a start that threw was, by its error. */
const failureOf = (error: unknown): Failure | "gone" => {
  if (!isExpectedError(error) || isStaleRefusal(error)) {
    return { kind: "core" };
  }
  if (error.code === "workflow.trigger_unavailable") {
    return "gone";
  }
  return refusedForGood.has(error.code)
    ? { kind: "refused", code: error.code }
    : { kind: "failed" };
};

/** Starts the run of `schedule`'s due occurrence, then sets its next one. */
const startScheduled = async (
  env: Env,
  schedule: DueSchedule,
  now: Date
): Promise<void> => {
  try {
    await startWorkflow(
      env,
      { type: "trigger", triggerId: schedule.triggerId },
      schedule.workflowId,
      {
        version: schedule.workflowVersion,
        input: z.json().parse(JSON.parse(schedule.input)),
        key: startKeyOf(schedule),
      },
      // Admitted only while this occurrence is still the schedule's next:
      // disabled and enabled again since it was read, or moved, the
      // schedule was worked out again, and this one starts nothing.
      stillNext(schedule),
      {
        scheduledAt: schedule.nextAt.toISOString(),
        triggerVersion: String(schedule.version),
      }
    );
  } catch (error) {
    const failure = failureOf(error);
    if (failure === "gone") {
      // Disabled, deleted or moved since it was read: it is read as due no
      // more, so nothing is left to try.
      log.info("trigger.schedule.gone", { trigger: schedule.triggerId });
      return;
    }
    if (failure.kind !== "refused") {
      log.error("trigger.schedule.failed", {
        trigger: schedule.triggerId,
        kind: failure.kind,
        ...errorFields(error),
      });
    }
    await recordFailure(env, schedule, now, failure);
    return;
  }
  // Every occurrence missed up to now, the one just started for them all.
  await drizzle(env.DB)
    .update(triggerSchedules)
    .set({
      nextAt: nextOccurrence(schedule.cron, schedule.timeZone, now) ?? null,
      failedStarts: 0,
      attempts: 0,
      lastAttemptAt: null,
    })
    .where(sameOccurrence(schedule));
};

/**
 * Starts the runs of the schedule triggers due by `now`, oldest first, of
 * live, enabled triggers on the version their schedule was worked out
 * for. Core's clock calls it every minute.
 */
export const startDueScheduleTriggers = async (
  env: Env,
  now = new Date()
): Promise<void> => {
  const due = await drizzle(env.DB)
    .select({
      triggerId: triggerSchedules.triggerId,
      version: triggerSchedules.version,
      ownerId: triggerResources.ownerId,
      nextAt: triggerSchedules.nextAt,
      failedStarts: triggerSchedules.failedStarts,
      attempts: triggerSchedules.attempts,
      workflowId: triggerResourceVersions.workflowResourceId,
      workflowVersion: triggerResourceVersions.workflowResourceVersion,
      cron: triggerResourceVersions.scheduleCron,
      timeZone: triggerResourceVersions.scheduleTimeZone,
      input: triggerResourceVersions.scheduleInput,
    })
    .from(triggerSchedules)
    .innerJoin(
      triggerResources,
      and(
        eq(triggerResources.id, triggerSchedules.triggerId),
        eq(triggerResources.currentVersion, triggerSchedules.version),
        eq(triggerResources.kind, "schedule"),
        eq(triggerResources.enabled, true),
        isNull(triggerResources.deletedAt)
      )
    )
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerSchedules.triggerId),
        eq(triggerResourceVersions.version, triggerSchedules.version)
      )
    )
    .where(and(lte(triggerSchedules.nextAt, now), tryNow(now)))
    .orderBy(asc(triggerSchedules.nextAt))
    .limit(schedulesPerRun);
  await Promise.all(
    due.flatMap(({ nextAt, cron, timeZone, input, ...schedule }) =>
      nextAt === null || cron === null || timeZone === null || input === null
        ? []
        : [
            startScheduled(
              env,
              { ...schedule, nextAt, cron, timeZone, input },
              now
            ),
          ]
    )
  );
};
