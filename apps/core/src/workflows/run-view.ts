import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import { and, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { Member } from "../auth/identity.ts";
import { workflowDecisions, workflowResourceRuns } from "../db/core/schema.ts";
import { resourceDecisionPending } from "../decisions/decisions.ts";
import { listWorkflowResources } from "../workflow-resources.ts";
import type { RunRow } from "./resource-runs.ts";

// The one view of runs the Workflows page, its Runs tab, the dashboard's
// activity and the platform's statistics read: the runs of independent
// workflows (`workflow_resource_runs`), as the columns they count and list
// by.
//
// Who sees which runs is the view's too (`RunScope`): of the independent
// workflows a person has a role in, every run for a builder (admins among
// them) and their own for a user, as the workflow's own page lists them
// (resource-runs.ts, `listResourceRuns`).

/** A list of values, as one bound JSON parameter (D1 binds at most 100). */
export const listOf = (values: readonly string[]): SQL =>
  sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

/** Whose runs the view shows. */
export interface RunScope {
  /** Independent workflows every run of which it shows. */
  workflows: readonly string[];
  /** Independent workflows of which it shows `principal`'s runs alone. */
  ownWorkflows: readonly string[];
  /** Whose runs `ownWorkflows` shows. */
  principal: string;
}

/** What a person sees: the workflows, and the scope of their runs. */
export interface Visible {
  /** The independent workflows they have a role in, by name. */
  workflows: WorkflowResource[];
  scope: RunScope;
}

/**
 * The runs `by` sees of the independent workflows `workflows`, each with
 * their role in it: every run of those they build, their own of those
 * they use.
 */
export const scopeOf = (
  by: Pick<Member, "userId">,
  workflows: readonly Pick<WorkflowResource, "id" | "role">[]
): RunScope => ({
  workflows: workflows.flatMap(({ id, role }) =>
    role === "builder" ? [id] : []
  ),
  ownWorkflows: workflows.flatMap(({ id, role }) =>
    role === "builder" ? [] : [id]
  ),
  principal: by.userId,
});

/**
 * The independent workflows `by` has a role in (`listWorkflowResources`),
 * and the runs of them they see.
 */
export const visibleToMember = async (
  env: Env,
  by: Member
): Promise<Visible> => {
  const workflows = await listWorkflowResources(env, by);
  return { workflows, scope: scopeOf(by, workflows) };
};

/** The run's columns, under the view's names, for what narrows it. */
export interface RunColumns {
  id: SQL;
  workflow: SQL;
  principal: SQL;
  status: SQL;
  createdAt: SQL;
  endedAt: SQL;
}

/** What narrows the view: a condition on its columns, or nothing. */
export type RunWhere = (run: RunColumns) => SQL | undefined;

const columnsOf: RunColumns = {
  id: sql`${workflowResourceRuns.id}`,
  workflow: sql`${workflowResourceRuns.workflowResourceId}`,
  principal: sql`${workflowResourceRuns.principalId}`,
  status: sql`${workflowResourceRuns.status}`,
  createdAt: sql`${workflowResourceRuns.createdAt}`,
  endedAt: sql`${workflowResourceRuns.endedAt}`,
};

/**
 * That a run waits at `now` for a decision someone can still answer
 * (`resourceDecisionPending`). One past its deadline that the run hasn't
 * timed out yet doesn't count: nobody can answer it, and the run goes on
 * by itself once it times it out. Nor does one of a run that ended, or
 * whose cancel was admitted.
 */
export const waits = (now: Date): SQL => sql`EXISTS (
  SELECT 1 FROM ${workflowDecisions}
  WHERE ${workflowDecisions.resourceRunId} = ${workflowResourceRuns.id}
    AND ${resourceDecisionPending(now)}
)`;

/** That a run asked a person for a decision, at any time. */
const asked = (): SQL => sql`EXISTS (
  SELECT 1 FROM ${workflowDecisions}
  WHERE ${workflowDecisions.resourceRunId} = ${workflowResourceRuns.id}
)`;

/**
 * The runs of `scope`: every run of `workflows`, `principal`'s alone of
 * `ownWorkflows`. Undefined when it holds none.
 */
const runsSeen = (scope: RunScope, workflow: SQL): SQL | undefined => {
  const every =
    scope.workflows.length === 0
      ? undefined
      : sql`${workflow} IN ${listOf(scope.workflows)}`;
  const own =
    scope.ownWorkflows.length === 0
      ? undefined
      : and(
          sql`${workflow} IN ${listOf(scope.ownWorkflows)}`,
          eq(workflowResourceRuns.principalId, scope.principal)
        );
  return every === undefined || own === undefined
    ? (every ?? own)
    : or(every, own);
};

/**
 * That a run is one `scope` sees, as a condition on its row, for a read
 * that finds its runs some other way (from the open decisions,
 * workflows/overview.ts): which workflow it is of is checked, never looked
 * up. Undefined when the scope holds none.
 */
export const seenBy = (scope: RunScope): SQL | undefined =>
  runsSeen(scope, sql`+${workflowResourceRuns.workflowResourceId}`);

/** The select of the view, narrowed by `where`: see `runView`. */
const selectOf = (
  db: DrizzleD1Database,
  scope: RunScope,
  now: Date,
  where: RunWhere | undefined,
  ordered: boolean
) => {
  // `+column` is never looked up by an index (overview.ts says more).
  const workflow = sql`${workflowResourceRuns.workflowResourceId}`;
  const seen = runsSeen(scope, ordered ? sql`+${workflow}` : workflow);
  return seen === undefined
    ? undefined
    : db
        .select({
          id: sql<string>`${columnsOf.id}`.as("view_id"),
          workflow: sql<string>`${columnsOf.workflow}`.as("view_workflow"),
          principal: sql<string>`${columnsOf.principal}`.as("view_principal"),
          status: sql<RunRow["status"]>`${columnsOf.status}`.as("view_status"),
          createdAt: sql<number>`${columnsOf.createdAt}`.as("view_created_at"),
          endedAt: sql<number | null>`${columnsOf.endedAt}`.as("view_ended_at"),
          unended: sql<number>`${workflowResourceRuns.endedAt} IS NULL`.as(
            "view_unended"
          ),
          waits: sql<number>`${waits(now)}`.as("view_waits"),
          asked: sql<number>`${asked()}`.as("view_asked"),
        })
        .from(workflowResourceRuns)
        .where(and(seen, where?.(columnsOf)))
        .$dynamic();
};

/**
 * The runs `scope` sees, narrowed by `where`, as one subquery named `run`,
 * its columns named `view_…` so a join never mistakes them for another
 * table's: its ID, workflow, the person it acts for, status, when it
 * started and ended (Unix milliseconds), whether it goes on (it hasn't
 * ended), and whether it waits at `now` for a decision, or ever asked for
 * one. Undefined when the scope holds no workflow. What reads it groups
 * and counts; a list in an order reads `orderedRuns`.
 *
 * It finds the runs of its workflows by their own index
 * (`workflow_resource_runs_newest_idx`), unless `ordered`: then which
 * workflow a run is of is checked, never looked up, so the read takes the
 * index its condition wants.
 */
export const runView = (
  db: DrizzleD1Database,
  scope: RunScope,
  now: Date,
  where?: RunWhere,
  ordered = false
) => selectOf(db, scope, now, where, ordered)?.as("run");

/** How a list orders runs: newest first by start, or latest ended first; then by ID. */
export type RunOrder = "newest" | "latestEnded";

/** A run as `orderedRuns` lists it. */
export interface OrderedRun {
  id: string;
  createdAt: number;
  endedAt: number | null;
}

/**
 * The first `limit` runs `scope` sees, narrowed by `where`, in `order`,
 * read by the index of that order and stopped at `limit`, so no list sorts
 * every run it might show. Which workflow a run is of is checked, never
 * looked up (`ordered`).
 */
export const orderedRuns = async (
  db: DrizzleD1Database,
  scope: RunScope,
  now: Date,
  where: RunWhere,
  order: RunOrder,
  limit: number
): Promise<OrderedRun[]> => {
  const select = selectOf(db, scope, now, where, true);
  if (select === undefined) {
    return [];
  }
  const rows = await select
    .orderBy(
      sql`${order === "newest" ? columnsOf.createdAt : columnsOf.endedAt} DESC`,
      sql`${columnsOf.id} DESC`
    )
    .limit(limit);
  return rows.map(({ id, createdAt, endedAt }) => ({ id, createdAt, endedAt }));
};
