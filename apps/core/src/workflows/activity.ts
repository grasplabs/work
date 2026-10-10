import { workflowIdSchema } from "@grasp-os/shared/ids";
import {
  runActivityQuerySchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type {
  RunActivity,
  RunActivityDay,
  RunActivityWorkflow,
} from "@grasp-os/shared/workflows";
import { and, count, eq, gte, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import type { Member } from "../auth/identity.ts";
import { workflowDecisions, workflowRuns } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { stillOpen } from "../decisions/decisions.ts";
import { runUnended, visibleApps, waits } from "./overview.ts";
import type { ListedApp } from "./overview.ts";

// The runs of the Apps a person can open, started over the last days, and
// the people they needed: the dashboard's Runs widget. The same Apps as
// the Workflows page (`visibleApps`), and, like it, a read nobody audits:
// counts of runs the person may list one by one anyway.
//
// Everything is counted from the runs started in the window, by the UTC
// day they started, as they stand now: a run started on Monday that fails
// on Tuesday is one of Monday's failed runs, and the decisions counted are
// those runs' decisions. Runs are read by the start of their App's runs
// (`workflow_runs_app_idx`, as the platform's `workflow_runs` statistic
// reads them), their decisions by run (`workflow_decisions_run_status_idx`),
// so a read takes the runs of the window and no more, in three grouped
// statements: one batch, so their counts agree.

type Db = DrizzleD1Database;

const dayMs = 24 * 60 * 60 * 1000;

/** How a run stands, as the activity counts it. */
const runBuckets = ["completed", "failed", "waiting", "other"] as const;

/**
 * How a run stands at `now`: waiting while it hasn't ended and a decision
 * of its is open (as the Workflows page says), completed, failed, or
 * anything else (running, paused, cancelled).
 */
const bucketOf = (now: Date): SQL<string> => sql<string>`CASE
  WHEN ${waits(now)} THEN 'waiting'
  WHEN ${workflowRuns.status} IN ('completed', 'failed') THEN ${workflowRuns.status}
  ELSE 'other'
END`;

/**
 * That a run asked a person for a decision, at any time. A subquery of
 * drizzle's own, whose condition names each column with its table: in
 * what a single table's query selects, drizzle names a column without it,
 * and `id` would then be the decision's.
 */
const asked = (db: Db): SQL<number> =>
  sql<number>`EXISTS ${db
    .select({ one: sql`1` })
    .from(workflowDecisions)
    .where(eq(workflowDecisions.runId, workflowRuns.id))}`;

/**
 * The UTC day number a run started on: its milliseconds divided by a
 * day's as integers, written out, since D1 binds a number as a real and
 * would divide to a fraction.
 */
const dayNumber = (): SQL<number> =>
  sql<number>`${workflowRuns.createdAt} / ${sql.raw(String(dayMs))}`;

/**
 * How a decision of a run stands at `now`: answered, timed out, open (one
 * someone can still answer, of a run that hasn't ended), or none of these:
 * past its deadline or of a run that ended, which nobody answers.
 */
const decisionBucketOf = (now: Date): SQL<string> => sql<string>`CASE
  WHEN ${workflowDecisions.status} <> 'open' THEN ${workflowDecisions.status}
  WHEN ${stillOpen(workflowDecisions, now)} AND ${runUnended()} THEN 'open'
  ELSE 'closed'
END`;

const dayRowSchema = z.object({
  day: z.number(),
  bucket: z.enum(runBuckets),
  asked: z.number(),
  count: z.number(),
});

const workflowRowSchema = z.object({
  app: z.string(),
  workflow: z.string(),
  bucket: z.enum(runBuckets),
  count: z.number(),
});

const decisionRowSchema = z.object({
  bucket: z.enum(["approved", "rejected", "timed_out", "open", "closed"]),
  count: z.number(),
});

/** `YYYY-MM-DD` of the UTC day `day` days after 1 January 1970. */
const dateOf = (day: number): string =>
  new Date(day * dayMs).toISOString().slice(0, 10);

/** Each UTC day from `first` to `last`, with no runs yet. */
const emptyDays = (first: number, last: number): RunActivityDay[] =>
  Array.from({ length: last - first + 1 }, (_, index) => ({
    day: dateOf(first + index),
    completed: 0,
    failed: 0,
    waiting: 0,
    other: 0,
    withPerson: 0,
  }));

/** Nothing ran: the days of the window, and no counts. */
const noActivity = (first: number, last: number): RunActivity => ({
  from: dateOf(first),
  to: dateOf(last),
  days: emptyDays(first, last),
  runs: { total: 0, withPerson: 0, withoutPerson: 0 },
  decisions: { approved: 0, rejected: 0, timedOut: 0, open: 0 },
  workflows: [],
});

/**
 * The runs of the Apps `by` can open started over the last `days` UTC
 * days before `now`, today included (`runActivityQuerySchema`, as
 * `input`), by day and how they stand, the decisions they asked for, and
 * each workflow's.
 */
export const runActivity = async (
  env: Env,
  by: Member,
  input?: unknown,
  now = new Date()
): Promise<RunActivity> => {
  const parsed = runActivityQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  const last = Math.floor(now.getTime() / dayMs);
  const first = last - parsed.data.days + 1;
  const apps = await visibleApps(env, by);
  if (apps.length === 0) {
    return noActivity(first, last);
  }
  const ids = apps.map(({ id }) => id);
  const inWindow = and(
    inList(workflowRuns.appId, ids),
    gte(workflowRuns.createdAt, new Date(first * dayMs)),
    lte(workflowRuns.createdAt, now)
  );
  const db = drizzle(env.DB);
  const bucket = bucketOf(now);
  const decisionBucket = decisionBucketOf(now);
  const [dayRows, workflowRows, decisionRows] = await db.batch([
    db
      .select({ day: dayNumber(), bucket, asked: asked(db), count: count() })
      .from(workflowRuns)
      .where(inWindow)
      .groupBy(dayNumber(), bucket, asked(db)),
    db
      .select({
        app: workflowRuns.appId,
        workflow: workflowRuns.workflowId,
        bucket,
        count: count(),
      })
      .from(workflowRuns)
      .where(inWindow)
      .groupBy(workflowRuns.appId, workflowRuns.workflowId, bucket),
    db
      .select({ bucket: decisionBucket, count: count() })
      .from(workflowRuns)
      .innerJoin(
        workflowDecisions,
        eq(workflowDecisions.runId, workflowRuns.id)
      )
      .where(inWindow)
      .groupBy(decisionBucket),
  ]);

  const activity = noActivity(first, last);
  for (const row of z.array(dayRowSchema).parse(dayRows)) {
    const day = activity.days[row.day - first];
    const withPerson = row.asked === 1;
    if (day !== undefined) {
      day[row.bucket] += row.count;
      day.withPerson += withPerson ? row.count : 0;
    }
    activity.runs.total += row.count;
    activity.runs[withPerson ? "withPerson" : "withoutPerson"] += row.count;
  }
  for (const row of z.array(decisionRowSchema).parse(decisionRows)) {
    if (row.bucket !== "closed") {
      activity.decisions[row.bucket === "timed_out" ? "timedOut" : row.bucket] =
        row.count;
    }
  }
  const order = new Map<string, { app: ListedApp; index: number }>(
    apps.map((app, index) => [app.id, { app, index }])
  );
  const workflows = new Map<string, RunActivityWorkflow>();
  for (const row of z.array(workflowRowSchema).parse(workflowRows)) {
    const key = JSON.stringify([row.app, row.workflow]);
    const app = order.get(row.app)?.app;
    if (app !== undefined) {
      const entry = workflows.get(key) ?? {
        app: app.id,
        appName: app.name,
        workflow: workflowIdSchema.parse(row.workflow),
        current: app.workflows.includes(row.workflow),
        started: 0,
        completed: 0,
        failed: 0,
      };
      entry.started += row.count;
      if (row.bucket === "completed" || row.bucket === "failed") {
        entry[row.bucket] += row.count;
      }
      workflows.set(key, entry);
    }
  }
  activity.workflows = [...workflows.values()].toSorted(
    (a, b) =>
      (order.get(a.app)?.index ?? 0) - (order.get(b.app)?.index ?? 0) ||
      a.workflow.localeCompare(b.workflow)
  );
  return activity;
};
