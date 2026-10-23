import {
  appIdSchema,
  workflowIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import {
  runActivityQuerySchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type {
  RunActivity,
  RunActivityDay,
  RunActivityWorkflow,
} from "@grasp-os/shared/workflows";
import { count, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Member } from "../auth/identity.ts";
import { workflowDecisions } from "../db/core/schema.ts";
import { stillOpen } from "../decisions/decisions.ts";
import { runView, visibleToMember } from "./run-view.ts";
import type { ListedApp } from "./run-view.ts";

// The runs a person can list, started over the last days, and the people
// they needed: the dashboard's Runs widget. The same runs as the Workflows
// page's Runs tab (run-view.ts), and, like it, a read nobody audits: counts
// of runs the person may list one by one anyway.
//
// Everything is counted from the runs started in the window, by the UTC
// day they started, as they stand now: a run started on Monday that fails
// on Tuesday is one of Monday's failed runs, and the decisions counted are
// those runs' decisions. Runs are read by the start of their App's runs
// (`workflow_runs_app_idx`, as the platform's `workflow_runs` statistic
// reads them) or their workflow's (`workflow_resource_runs_newest_idx`),
// their decisions by run (`workflow_decisions_run_status_idx`), so a read
// takes the runs of the window and no more, in three grouped statements:
// one batch, so their counts agree.

const dayMs = 24 * 60 * 60 * 1000;

/** How a run stands, as the activity counts it. */
const runBuckets = ["completed", "failed", "waiting", "other"] as const;

/**
 * The run view's runs started in the window, by the columns the counts
 * read; `run` names it.
 */
type Runs = NonNullable<ReturnType<typeof runView>>;

/**
 * How a run stands at `now`: waiting while it hasn't ended and a decision
 * of its is open (as the Workflows page says), completed, failed, or
 * anything else (running, paused, cancelled).
 */
const bucketOf = (run: Runs): SQL<string> => sql<string>`CASE
  WHEN ${run.waits} THEN 'waiting'
  WHEN ${run.status} IN ('completed', 'failed') THEN ${run.status}
  ELSE 'other'
END`;

/**
 * The UTC day number a run started on: its milliseconds divided by a
 * day's as integers, written out, since D1 binds a number as a real and
 * would divide to a fraction.
 */
const dayNumber = (run: Runs): SQL<number> =>
  sql<number>`${run.createdAt} / ${sql.raw(String(dayMs))}`;

/**
 * How a decision of a run stands at `now`: answered, timed out, open (one
 * someone can still answer, of a run that hasn't ended and nobody asked to
 * cancel), or none of these: past its deadline or of a run that ended,
 * which nobody answers.
 */
const decisionBucketOf = (run: Runs, now: Date): SQL<string> => sql<string>`CASE
  WHEN ${workflowDecisions.status} <> 'open' THEN ${workflowDecisions.status}
  WHEN ${stillOpen(workflowDecisions, now)} AND ${run.unended} THEN 'open'
  ELSE 'closed'
END`;

const dayRowSchema = z.object({
  day: z.number(),
  bucket: z.enum(runBuckets),
  asked: z.number(),
  count: z.number(),
});

const workflowRowSchema = z.object({
  kind: z.enum(["app", "resource"]),
  app: z.string().nullable(),
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

/** A workflow's entry, with no runs yet, and where the lists put it. */
const entryOf = (
  row: z.infer<typeof workflowRowSchema>,
  apps: ReadonlyMap<string, { app: ListedApp; index: number }>,
  named: ReadonlyMap<string, { workflow: WorkflowResource; index: number }>
): (RunActivityWorkflow & { order: number }) | undefined => {
  const counts = { started: 0, completed: 0, failed: 0 };
  if (row.kind === "resource") {
    const found = named.get(row.workflow);
    return found === undefined
      ? undefined
      : {
          type: "resource",
          workflowId: workflowResourceIdSchema.parse(found.workflow.id),
          name: found.workflow.name,
          ...counts,
          order: found.index,
        };
  }
  const found = row.app === null ? undefined : apps.get(row.app);
  return found === undefined
    ? undefined
    : {
        type: "app",
        app: appIdSchema.parse(found.app.id),
        appName: found.app.name,
        workflow: workflowIdSchema.parse(row.workflow),
        current: found.app.workflows.includes(row.workflow),
        ...counts,
        order: found.index,
      };
};

/**
 * The runs `by` can list started over `days` UTC days up to `to` (today
 * unless given), both included (`runActivityQuerySchema`, as `input`), by
 * day and how they stand at `now`, the decisions they asked for, and each
 * workflow's: an App's by App name, then workflow, then the independent
 * ones by name. A `to` after today is refused.
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
  const today = Math.floor(now.getTime() / dayMs);
  const { to } = parsed.data;
  const last = to === undefined ? today : Date.parse(`${to}T00:00:00Z`) / dayMs;
  if (last > today) {
    throw workflowErrors.create("workflow.invalid");
  }
  const first = last - parsed.data.days + 1;
  // Up to now on today, or to the end of an earlier last day.
  const until = last === today ? now : new Date((last + 1) * dayMs - 1);
  const visible = await visibleToMember(env, by);
  const db = drizzle(env.DB);
  const run = runView(
    db,
    visible.scope,
    now,
    (arm) =>
      sql`${arm.createdAt} >= ${first * dayMs} AND ${arm.createdAt} <= ${until.getTime()}`
  );
  if (run === undefined) {
    return noActivity(first, last);
  }
  const bucket = bucketOf(run);
  const decisionBucket = decisionBucketOf(run, now);
  const [dayRows, workflowRows, decisionRows] = await db.batch([
    db
      .select({
        day: dayNumber(run),
        bucket,
        asked: run.asked,
        count: count(),
      })
      .from(run)
      .groupBy(dayNumber(run), bucket, sql`${run.asked}`),
    db
      .select({
        kind: run.kind,
        app: run.app,
        workflow: run.workflow,
        bucket,
        count: count(),
      })
      .from(run)
      .groupBy(sql`${run.kind}`, sql`${run.app}`, sql`${run.workflow}`, bucket),
    db
      .select({ bucket: decisionBucket, count: count() })
      .from(run)
      .innerJoin(workflowDecisions, eq(workflowDecisions.runId, run.id))
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
  // Each workflow under its place in the lists: its App's, then its own.
  const apps = new Map(
    visible.apps.map((app, index) => [app.id, { app, index }])
  );
  const named = new Map(
    visible.workflows.map((workflow, index) => [
      workflow.id,
      { workflow, index: apps.size + index },
    ])
  );
  const workflows = new Map<string, RunActivityWorkflow & { order: number }>();
  for (const row of z.array(workflowRowSchema).parse(workflowRows)) {
    const key = JSON.stringify([row.app, row.workflow]);
    const entry = workflows.get(key) ?? entryOf(row, apps, named);
    if (entry !== undefined) {
      entry.started += row.count;
      if (row.bucket === "completed" || row.bucket === "failed") {
        entry[row.bucket] += row.count;
      }
      workflows.set(key, entry);
    }
  }
  activity.workflows = [...workflows.values()]
    .toSorted(
      (a, b) =>
        a.order - b.order ||
        (a.type === "app" && b.type === "app"
          ? a.workflow.localeCompare(b.workflow)
          : 0)
    )
    .map(({ order: _order, ...entry }) => entry);
  return activity;
};
