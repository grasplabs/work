import { runIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import {
  failedRunDays,
  handledRunDays,
  runFilterStatuses,
  runsPageSize,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type {
  LatestRun,
  ListedRun,
  RunFilterStatus,
  RunsPage,
  RunStatus,
  WorkflowSummary,
} from "@grasp-os/shared/workflows";
import { and, desc, eq, gt, notExists, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import type { Member } from "../auth/identity.ts";
import {
  users,
  workflowDecisions,
  workflowResourceRuns,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import {
  answerableBy,
  resourceDecisionPending,
  stillOpen,
} from "../decisions/decisions.ts";
import { queuedRuns } from "./admission.ts";
import type { RunRow } from "./resource-runs.ts";
import {
  listOf,
  orderedRuns,
  runView,
  seenBy,
  visibleToMember,
  waits,
} from "./run-view.ts";
import type { RunOrder, RunScope, RunWhere } from "./run-view.ts";
import { goesOn, queuedRun, shownStatus, unended } from "./runs.ts";

// Every independent workflow a person has a role in, and their runs: the
// Workflows page, its Runs tab and the workflow view, with the runs their
// pages list them: every run for a builder, their own for a user
// (run-view.ts).
//
// A run waits when one of its decisions still takes answers, as
// answering decides it (`resourceDecisionPending`): open, not past its
// deadline, and its run going on, no cancel of it admitted. It goes on
// once someone answers it, on the decision's own page. A run that waits
// otherwise (a sleep, a decision past its deadline that it hasn't timed
// out yet) goes on by itself, and counts as running; so does one whose
// cancel was admitted, until the engine stops it.
//
// A run that goes on without a decision to wait for, while a step of it is
// held for a working AI provider key (ai-waits.ts), shows as queued
// (admission.ts, `queuedRuns`), with the provider and since when. The
// Running filter lists it: it goes on by itself, not a failure.
//
// The queries are written for a D1 without statistics (a fresh one never
// has them), where SQLite picks indexes by the query's shape alone. Each
// list reads one index in the order it returns rows, and stops at a page:
// runs newest first by `workflow_resource_runs_created_idx`, failed runs
// by `workflow_resource_runs_status_ended_idx`, waiting runs from the open
// decisions (`workflow_decisions_status_opened_idx`), runs that haven't
// ended by status. A filter that must not pick an index of its own is
// written `+column`, which SQLite never looks up by an index: so the list
// of workflows someone sees never turns a page into a sort of every run of
// them. workflow-overview.test.ts checks the plans.

type Db = DrizzleD1Database;

const dayMs = 24 * 60 * 60 * 1000;

const latestRunSchema = z.object({
  id: z.string(),
  workflow: z.string(),
  status: z.enum([
    "starting",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]),
  createdAt: z.number(),
  waits: z.number(),
});

type LatestRow = z.infer<typeof latestRunSchema>;

/**
 * Each of the workflows `workflows`' latest run of those `by` sees: any
 * run of one they build, their own of one they use. One query, which looks
 * each up in `workflow_resource_runs_newest_idx` newest first and stops at
 * one, so it reads one run a workflow however many runs each has.
 */
const latestRuns = async (
  db: Db,
  by: Member,
  workflows: readonly WorkflowResource[],
  now: Date
): Promise<LatestRow[]> => {
  if (workflows.length === 0) {
    return [];
  }
  const wanted = JSON.stringify(
    workflows.map(({ id, role }) => [id, role === "builder" ? null : by.userId])
  );
  const runs = workflowResourceRuns;
  const rows = await db.all(sql`
    SELECT latest.id, latest.workflow_resource_id AS workflow, latest.status,
      latest.created_at AS createdAt,
      EXISTS (
        SELECT 1 FROM ${workflowDecisions}
        WHERE ${workflowDecisions.resourceRunId} = latest.id
          AND ${resourceDecisionPending(now)}
      ) AS waits
    FROM json_each(${wanted}) AS wanted
    INNER JOIN ${runs} AS latest ON latest.id = (
      SELECT id FROM ${runs}
      WHERE workflow_resource_id = wanted.value ->> 0
        AND (wanted.value ->> 1 IS NULL
          OR principal_id = wanted.value ->> 1)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )`);
  return z.array(latestRunSchema).parse(rows);
};

/**
 * The latest runs `rows` by workflow: `waiting` while one waits for a
 * decision; one that goes on otherwise may be held for its AI provider.
 */
const latestByWorkflow = async (
  db: Db,
  rows: readonly LatestRow[]
): Promise<Map<string, LatestRun>> => {
  const queues = await queuedRuns(
    db,
    rows.flatMap(({ id, status, waits: waiting }) =>
      goesOn(status) && waiting !== 1 ? [id] : []
    )
  );
  return new Map(
    rows.map((row) => {
      const status: RunStatus =
        row.waits === 1 ? "waiting" : shownStatus(row.status);
      const queue = queues.get(row.id);
      return [
        row.workflow,
        {
          id: runIdSchema.parse(row.id),
          ...(status === "running" && queue !== undefined
            ? { status: "queued" as const, ...queue }
            : { status }),
          createdAt: new Date(row.createdAt).toISOString(),
        },
      ];
    })
  );
};

/**
 * How many of the runs `scope` sees match `where`, by workflow, read
 * through the view in the order `where`'s own index gives them.
 */
const countedBy = async (
  db: Db,
  scope: RunScope,
  now: Date,
  where: RunWhere
): Promise<Map<string, number>> => {
  const run = runView(db, scope, now, where, true);
  if (run === undefined) {
    return new Map();
  }
  const rows = await db
    .select({ workflow: run.workflow, count: sql<number>`count(*)` })
    .from(run)
    .groupBy(sql`${run.workflow}`);
  return new Map(rows.map(({ workflow, count }) => [workflow, count]));
};

/**
 * How many of the runs `scope` sees wait for a decision now, by workflow:
 * counted from the open decisions (`workflow_decisions_status_opened_idx`),
 * each run once, so the count reads what is open, never every run ended
 * long ago.
 */
const waitingBy = async (
  db: Db,
  scope: RunScope,
  now: Date
): Promise<Map<string, number>> => {
  const seen = seenBy(scope);
  if (seen === undefined) {
    return new Map();
  }
  const rows = await db
    .select({
      workflow: workflowResourceRuns.workflowResourceId,
      count: sql<number>`count(DISTINCT ${workflowResourceRuns.id})`,
    })
    .from(workflowDecisions)
    .innerJoin(
      workflowResourceRuns,
      eq(workflowResourceRuns.id, workflowDecisions.resourceRunId)
    )
    .where(and(resourceDecisionPending(now), seen))
    .groupBy(workflowResourceRuns.workflowResourceId);
  return new Map(rows.map(({ workflow, count }) => [workflow, count]));
};

/** That a run ended `status` since `since`. */
const endedSince =
  (status: "completed" | "failed", since: Date): RunWhere =>
  (run) =>
    sql`${run.status} = ${status} AND ${run.endedAt} >= ${since.getTime()}`;

/** The names of the people `ids`, by ID. */
const ownerNames = async (
  db: Db,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(sql`${users.id} IN ${listOf([...new Set(ids)])}`);
  return new Map(rows.map(({ id, name }) => [id, name]));
};

/**
 * Every independent workflow `by` has a role in, by name: each with its
 * owner, latest run, its runs waiting now, those failed lately and those
 * it handled this week (from the runs ended since): a fixed number of
 * queries, whatever the number of workflows.
 */
export const workflowOverview = async (
  env: Env,
  by: Member
): Promise<WorkflowSummary[]> => {
  const { workflows, scope } = await visibleToMember(env, by);
  if (workflows.length === 0) {
    return [];
  }
  const db = drizzle(env.DB);
  const now = new Date();
  const failedSince = new Date(now.getTime() - failedRunDays * dayMs);
  const handledSince = new Date(now.getTime() - handledRunDays * dayMs);
  const [latest, waiting, failed, handled, owners] = await Promise.all([
    latestRuns(db, by, workflows, now),
    waitingBy(db, scope, now),
    countedBy(db, scope, now, endedSince("failed", failedSince)),
    countedBy(db, scope, now, endedSince("completed", handledSince)),
    ownerNames(
      db,
      workflows.map(({ owner }) => owner)
    ),
  ]);
  const lastRuns = await latestByWorkflow(db, latest);
  return workflows.map((workflow) => ({
    workflowId: workflowResourceIdSchema.parse(workflow.id),
    name: workflow.name,
    version: workflow.currentVersion,
    owner: {
      userId: workflow.owner,
      name: owners.get(workflow.owner) ?? null,
    },
    lastRun: lastRuns.get(workflow.id) ?? null,
    waiting: waiting.get(workflow.id) ?? 0,
    failed: failed.get(workflow.id) ?? 0,
    handled: handled.get(workflow.id) ?? 0,
  }));
};

const runFilterSchema = z
  .strictObject({ status: z.enum(runFilterStatuses).optional() })
  .optional();

/** One more than a page: whether there are more tells itself. */
const pageAndOne = runsPageSize + 1;

/**
 * The runs `scope` sees waiting for a decision, latest to wait first: read
 * from the open decisions, each run once, by its latest open decision; a
 * page and one.
 */
const waitingRuns = async (
  db: Db,
  scope: RunScope,
  now: Date
): Promise<RunRow[]> => {
  const seen = seenBy(scope);
  if (seen === undefined) {
    return [];
  }
  const later = alias(workflowDecisions, "later");
  const rows = await db
    .select({ run: workflowResourceRuns })
    .from(workflowDecisions)
    .innerJoin(
      workflowResourceRuns,
      eq(workflowResourceRuns.id, workflowDecisions.resourceRunId)
    )
    .where(
      and(
        resourceDecisionPending(now),
        seen,
        // Its latest open decision alone, so each run comes once: of the
        // same run, so pending as it is once it is open.
        notExists(
          db
            .select({ one: sql`1` })
            .from(later)
            .where(
              and(
                eq(later.resourceRunId, workflowDecisions.resourceRunId),
                stillOpen(later, now),
                or(
                  gt(later.openedAt, workflowDecisions.openedAt),
                  and(
                    eq(later.openedAt, workflowDecisions.openedAt),
                    gt(later.id, workflowDecisions.id)
                  )
                )
              )
            )
        )
      )
    )
    .orderBy(desc(workflowDecisions.openedAt), desc(workflowDecisions.id))
    .limit(pageAndOne);
  return rows.map(({ run: row }) => row);
};

/**
 * The first page and one of the runs `scope` sees, as `where` narrows the
 * view, in `order` (run-view.ts, `orderedRuns`), with their rows.
 */
const viewRuns = async (
  db: Db,
  scope: RunScope,
  now: Date,
  where: RunWhere,
  order: RunOrder
): Promise<RunRow[]> => {
  const listed = await orderedRuns(db, scope, now, where, order, pageAndOne);
  if (listed.length === 0) {
    return [];
  }
  const rows = await db
    .select()
    .from(workflowResourceRuns)
    .where(
      inList(
        workflowResourceRuns.id,
        listed.map(({ id }) => id)
      )
    );
  const found = new Map(rows.map((row) => [row.id, row]));
  return listed.flatMap(({ id }) => {
    const one = found.get(id);
    return one === undefined ? [] : [one];
  });
};

/**
 * For each of the runs `runIds`, the latest of its open decisions `by` may
 * answer now (`answerableBy`), if any: one read of their decisions by run
 * (`workflow_decisions_resource_run_step_idx`), its status unary-plussed
 * off the organization-wide status index.
 */
const answerableDecisions = async (
  env: Env,
  db: Db,
  by: Member,
  runIds: readonly string[],
  now: Date
): Promise<Map<string, string>> => {
  if (runIds.length === 0) {
    return new Map();
  }
  const open = await db
    .select({
      id: workflowDecisions.id,
      runId: workflowDecisions.resourceRunId,
      deciders: workflowDecisions.deciders,
    })
    .from(workflowDecisions)
    .where(
      and(
        sql`${workflowDecisions.resourceRunId} IN ${listOf(runIds)}`,
        sql`+${workflowDecisions.status} = 'open'`,
        gt(workflowDecisions.expiresAt, now)
      )
    )
    .orderBy(desc(workflowDecisions.openedAt), desc(workflowDecisions.id));
  const answerable = await answerableBy(env, by, open);
  const byRun = new Map<string, string>();
  for (const { id, runId } of open) {
    if (runId !== null && answerable.has(id) && !byRun.has(runId)) {
      byRun.set(runId, id);
    }
  }
  return byRun;
};

/** Those of the runs `runIds` that wait at `now` for a decision someone can answer. */
const waitingIds = async (
  db: Db,
  runIds: readonly string[],
  now: Date
): Promise<Set<string>> => {
  if (runIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .selectDistinct({ id: workflowDecisions.resourceRunId })
    .from(workflowDecisions)
    .where(
      and(
        sql`${workflowDecisions.resourceRunId} IN ${listOf(runIds)}`,
        resourceDecisionPending(now)
      )
    );
  return new Set(rows.flatMap(({ id }) => (id === null ? [] : [id])));
};

/**
 * Runs `by` can see, as `input` (a `RunFilter`) narrows them: waiting
 * first, then failed (latest ended first), then the rest, newest first;
 * at most a page, and whether more matched. A run waiting for a decision
 * says so (`waiting`), with the decision when `by` may answer it now.
 */
export const listAllRuns = async (
  env: Env,
  by: Member,
  input?: unknown
): Promise<RunsPage> => {
  const parsed = runFilterSchema.safeParse(input);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  const filter = parsed.data ?? {};
  const { workflows, scope } = await visibleToMember(env, by);
  const names = new Map(workflows.map(({ id, name }) => [id, name]));
  const db = drizzle(env.DB);
  const now = new Date();
  const byStatus: Record<RunFilterStatus, () => Promise<RunRow[]>> = {
    waiting: async () => await waitingRuns(db, scope, now),
    // Read from the failed runs by end.
    failed: async () =>
      await viewRuns(
        db,
        scope,
        now,
        (run) => sql`${run.status} = 'failed'`,
        "latestEnded"
      ),
    // By status: runs that haven't ended are few, so sorting them costs
    // little.
    running: async () =>
      await viewRuns(
        db,
        scope,
        now,
        (run) => sql`${run.status} IN ${listOf(unended)} AND NOT ${waits(now)}`,
        "newest"
      ),
    done: async () =>
      await viewRuns(
        db,
        scope,
        now,
        (run) => sql`+${run.status} IN ('completed', 'cancelled')`,
        "newest"
      ),
  };
  const rest = async () =>
    await viewRuns(
      db,
      scope,
      now,
      (run) => sql`+${run.status} <> 'failed' AND NOT ${waits(now)}`,
      "newest"
    );
  const pages =
    filter.status === undefined
      ? await Promise.all([byStatus.waiting(), byStatus.failed(), rest()])
      : [await byStatus[filter.status]()];
  const matched = pages.flat();
  const found = matched.slice(0, runsPageSize);
  const unendedIds = found.flatMap((row) =>
    row.endedAt === null ? [row.id] : []
  );
  const [answering, waiting, queues] = await Promise.all([
    answerableDecisions(env, db, by, unendedIds, now),
    waitingIds(db, unendedIds, now),
    // A run waiting for a decision says so; one that goes on otherwise
    // may be held for its AI provider.
    queuedRuns(
      db,
      found.flatMap((row) => (goesOn(row.status) ? [row.id] : []))
    ),
  ]);
  return {
    runs: found.map((row): ListedRun => {
      const listed: ListedRun = {
        id: runIdSchema.parse(row.id),
        workflowId: workflowResourceIdSchema.parse(row.workflowResourceId),
        name: names.get(row.workflowResourceId) ?? "",
        version: row.version,
        startedBy: { type: "person", userId: row.principalId },
        status: waiting.has(row.id) ? "waiting" : shownStatus(row.status),
        createdAt: row.createdAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
      };
      // Only a run that waits links its decision: one whose cancel was
      // admitted takes no answer, whatever the decision's row says.
      const answered = waiting.has(row.id) ? answering.get(row.id) : undefined;
      const withDecision =
        answered === undefined ? listed : { ...listed, decision: answered };
      return waiting.has(row.id)
        ? withDecision
        : queuedRun(withDecision, queues.get(row.id));
    }),
    more: matched.length > runsPageSize,
  };
};
