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
} from "../db/core/schema.ts";
import { nextOccurrence } from "../trigger-resources.ts";
import { startWorkflow } from "../workflow-starts.ts";

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
//   the schedule goes on from its next occurrence.
// - A schedule that keeps failing, spinning. Each failed start counts;
//   one that may go another time (a full run limit, a failure of core's)
//   is tried again for the same occurrence, each try twice as long after
//   the one before (`tryNow`). After `maxFailedStarts` in a row, refused
//   or failed, it stops, keeping no next occurrence, audited once
//   (`trigger.schedule.stopped`), until it is enabled again or moved to
//   another version.
// - A backlog after an outage. Occurrences missed while the clock didn't
//   run start one run, for the first of them (spec 15.2, `coalesce`), and
//   the schedule goes on from its next occurrence after now.
// - A time that never was, or was twice. A local time the spring change
//   skips starts nothing; one the autumn change repeats starts once, at
//   the first (earlier) instant (`nextOccurrence`).
// - A disabled, deleted or moved trigger starting its old occurrences.
//   Only a live, enabled trigger whose current version is the one its
//   schedule was worked out for is read as due; enabling or moving it
//   works out its next occurrence again, from then, so what it missed
//   meanwhile starts nothing.

/** Most due schedules one clock run starts; the rest start a minute later. */
const schedulesPerRun = 50;

const minuteMs = 60_000;

/** Refusals of a start that may go another time: tried again, backing off. */
const retriedCodes: ReadonlySet<string> = new Set(["workflow.run_limit"]);

/** A due schedule trigger, as its current version pins it. */
interface DueSchedule {
  triggerId: string;
  version: number;
  nextAt: Date;
  failedStarts: number;
  workflowId: string;
  workflowVersion: number;
  cron: string;
  timeZone: string;
  input: string;
}

/** The start key of trigger version `schedule`'s occurrence at its `nextAt`. */
const startKeyOf = (schedule: DueSchedule): string =>
  `${coreStartKeyPrefix}schedule:${schedule.triggerId}:${schedule.version}:${schedule.nextAt.toISOString()}`;

/**
 * That a due schedule may be tried now: at once when no start of it has
 * failed, and after `n` failed ones, 2^n - 1 minutes after it was due.
 */
const tryNow = (now: Date) =>
  lte(
    sql`${triggerSchedules.nextAt} + ((1 << ${triggerSchedules.failedStarts}) - 1) * ${minuteMs}`,
    now.getTime()
  );

/** That `schedule` is still as it was read, as SQL. */
const asRead = (schedule: DueSchedule) =>
  and(
    eq(triggerSchedules.triggerId, schedule.triggerId),
    eq(triggerSchedules.version, schedule.version),
    eq(triggerSchedules.nextAt, schedule.nextAt),
    eq(triggerSchedules.failedStarts, schedule.failedStarts)
  );

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
 * Counts a failed start of `schedule`'s occurrence, only over the schedule
 * read, so one try counts once: refused for good (`refused`, audited), the
 * schedule goes on from its next occurrence after `now`; otherwise the
 * same occurrence stays due, tried again later. At `maxFailedStarts` it
 * stops, audited once.
 */
const countFailedStart = async (
  env: Env,
  schedule: DueSchedule,
  now: Date,
  refused?: string
): Promise<void> => {
  const failedStarts = schedule.failedStarts + 1;
  const stops = failedStarts >= maxFailedStarts;
  let nextAt: Date | null = schedule.nextAt;
  if (stops) {
    nextAt = null;
  } else if (refused !== undefined) {
    nextAt = nextOccurrence(schedule.cron, schedule.timeZone, now) ?? null;
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(triggerSchedules)
      .set({ nextAt, failedStarts })
      .where(asRead(schedule)),
    ...(refused === undefined
      ? []
      : [
          outboxedIfChanged(
            db,
            systemEntry(schedule, "trigger.schedule.refused", {
              scheduledAt: schedule.nextAt.toISOString(),
              code: refused,
            })
          ),
        ]),
    ...(stops
      ? [
          // Only if the update changed: `changes()` reads the statement
          // just before, the update or the refusal written only after it.
          outboxedIfChanged(
            db,
            systemEntry(schedule, "trigger.schedule.stopped", {
              failedStarts,
            })
          ),
        ]
      : []),
  ]);
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
      undefined,
      {
        scheduledAt: schedule.nextAt.toISOString(),
        triggerVersion: String(schedule.version),
      }
    );
  } catch (error) {
    const code = isExpectedError(error) ? error.code : undefined;
    if (code === "workflow.trigger_unavailable") {
      // Disabled, deleted or moved since it was read: it is read as due no
      // more, so nothing is left to try.
      log.info("trigger.schedule.gone", { trigger: schedule.triggerId });
      return;
    }
    if (code === undefined || retriedCodes.has(code)) {
      log.error("trigger.schedule.failed", {
        trigger: schedule.triggerId,
        ...errorFields(error),
      });
      await countFailedStart(env, schedule, now);
      return;
    }
    await countFailedStart(env, schedule, now, code);
    return;
  }
  // Every occurrence missed up to now, the one just started for them all.
  await drizzle(env.DB)
    .update(triggerSchedules)
    .set({
      nextAt: nextOccurrence(schedule.cron, schedule.timeZone, now) ?? null,
      failedStarts: 0,
    })
    .where(asRead(schedule));
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
      nextAt: triggerSchedules.nextAt,
      failedStarts: triggerSchedules.failedStarts,
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
