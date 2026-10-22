import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { appsFoundBy, appsReadableBy } from "../app-access.ts";
import type { Member } from "../auth/identity.ts";
import {
  apps,
  appVersions,
  users,
  workflowDecisions,
  workflowResourceRuns,
  workflowRuns,
} from "../db/core/schema.ts";
import { stillOpen } from "../decisions/decisions.ts";
import { listWorkflowResources } from "../workflow-resources.ts";
import { unended } from "./runs.ts";
import type { RunRow } from "./runs.ts";

// The one view of runs the Workflows page, its Runs tab, the dashboard's
// activity and the platform's statistics read: every run, an App's
// (`workflow_runs`) or an independent workflow's (`workflow_resource_runs`),
// as the same columns, so what reads it counts and lists both alike and
// never asks which table keeps a run. Retiring App-embedded workflows
// leaves the readers as they are: only the view's App arm goes.
//
// Who sees which runs is the view's too (`RunScope`): every run of the Apps
// a person can open (app-access.ts), and of the independent workflows they
// have a role in, every run for a builder (admins among them) and their own
// for a user, as the workflow's own page lists them (resource-runs.ts,
// `listResourceRuns`).
//
// Each arm reads its own table by its own indexes: what narrows the view
// (`RunArm`) is written into each arm, never left to SQLite to push into a
// compound subquery, and an arm with nothing to see isn't there at all.

/** A list of values, as one bound JSON parameter (D1 binds at most 100). */
export const listOf = (values: readonly string[]): SQL =>
  sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

/** An App as the lists need it, with its current version's workflows. */
export interface ListedApp {
  id: AppId;
  name: string;
  ownerId: string;
  ownerName: string | null;
  currentVersion: number | null;
  /** The workflow IDs its current version's row keeps. */
  workflows: string[];
}

/**
 * The Apps `by` can open now, by name: those they have a role in
 * (`appsFoundBy`) and whose data they can read
 * (`appsReadableBy`).
 */
export const visibleApps = async (
  env: Env,
  by: Member
): Promise<ListedApp[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: apps.id,
      name: apps.name,
      ownerId: apps.ownerId,
      ownerName: users.name,
      currentVersion: apps.currentVersion,
      workflows: appVersions.workflows,
    })
    .from(apps)
    .leftJoin(users, eq(users.id, apps.ownerId))
    .leftJoin(
      appVersions,
      and(
        eq(appVersions.appId, apps.id),
        eq(appVersions.version, apps.currentVersion)
      )
    )
    .where(appsFoundBy(env, by))
    .orderBy(asc(apps.name), asc(apps.id));
  const readable = await appsReadableBy(
    env,
    by,
    rows.map(({ id }) => id)
  );
  return rows
    .filter(({ id }) => readable.has(id))
    .map((row) => ({
      ...row,
      id: appIdSchema.parse(row.id),
      // None without a current version, whose row the join doesn't find.
      workflows: row.workflows ?? [],
    }));
};

/** Whose runs the view shows. */
export interface RunScope {
  /** Apps every run of which it shows. */
  apps: readonly string[];
  /** Independent workflows every run of which it shows. */
  workflows: readonly string[];
  /** Independent workflows of which it shows `principal`'s runs alone. */
  ownWorkflows: readonly string[];
  /** Whose runs `ownWorkflows` shows. */
  principal: string;
}

/** What a person sees: the Apps and workflows, and the scope of their runs. */
export interface Visible {
  apps: ListedApp[];
  /** The independent workflows they have a role in, by name. */
  workflows: WorkflowResource[];
  scope: RunScope;
}

/**
 * The runs `by` sees of the Apps `apps` (every run) and of the independent
 * workflows `workflows`, each with their role in it: every run of those
 * they build, their own of those they use.
 */
export const scopeOf = (
  by: Pick<Member, "userId">,
  appIds: readonly string[],
  workflows: readonly Pick<WorkflowResource, "id" | "role">[]
): RunScope => ({
  apps: appIds,
  workflows: workflows.flatMap(({ id, role }) =>
    role === "builder" ? [id] : []
  ),
  ownWorkflows: workflows.flatMap(({ id, role }) =>
    role === "builder" ? [] : [id]
  ),
  principal: by.userId,
});

/**
 * The Apps `by` can open (`visibleApps`) and the independent workflows they
 * have a role in (`listWorkflowResources`), and the runs of them they see.
 */
export const visibleToMember = async (
  env: Env,
  by: Member
): Promise<Visible> => {
  const [listed, workflows] = await Promise.all([
    visibleApps(env, by),
    listWorkflowResources(env, by),
  ]);
  return {
    apps: listed,
    workflows,
    scope: scopeOf(
      by,
      listed.map(({ id }) => id),
      workflows
    ),
  };
};

/**
 * One arm of the view: its table's columns under the view's names, for
 * what narrows it. `kind` says which table, for a condition only one of
 * them can hold (an App, a decision).
 */
export interface RunArm {
  kind: "app" | "resource";
  id: SQL;
  app: SQL;
  workflow: SQL;
  principal: SQL;
  status: SQL;
  createdAt: SQL;
  endedAt: SQL;
}

/**
 * What narrows each arm: a condition on its columns, nothing, or `false`
 * for an arm that can hold no run it wants, which the view then leaves
 * out.
 */
export type RunWhere = (arm: RunArm) => SQL | undefined | false;

const appArm: RunArm = {
  kind: "app",
  id: sql`${workflowRuns.id}`,
  app: sql`${workflowRuns.appId}`,
  workflow: sql`${workflowRuns.workflowId}`,
  principal: sql`${workflowRuns.startedBy}`,
  status: sql`${workflowRuns.status}`,
  createdAt: sql`${workflowRuns.createdAt}`,
  endedAt: sql`${workflowRuns.endedAt}`,
};

const resourceArm: RunArm = {
  kind: "resource",
  id: sql`${workflowResourceRuns.id}`,
  // Of the same affinity as an App's run's: a compound whose arms differ in
  // a column's affinity is never flattened, and its arms then read their
  // tables whole and sort them rather than read an index in order.
  app: sql`CAST(NULL AS TEXT)`,
  workflow: sql`${workflowResourceRuns.workflowResourceId}`,
  principal: sql`${workflowResourceRuns.principalId}`,
  status: sql`${workflowResourceRuns.status}`,
  createdAt: sql`${workflowResourceRuns.createdAt}`,
  endedAt: sql`${workflowResourceRuns.endedAt}`,
};

/**
 * That an App's run's open decisions can still be answered, never looked
 * up by an index: it hasn't ended, and nobody asked to cancel it. A cancel
 * is admitted before the engine stops the run, and its decisions take no
 * answer from then on (decisions.ts, `runUnended`), so they don't count as
 * waiting for anyone.
 */
export const runUnended = (): SQL =>
  sql`(+${workflowRuns.status} IN ${listOf(unended)} AND ${workflowRuns.cancelRequestedAt} IS NULL)`;

/**
 * That an App's run has a decision someone can still answer at `now`
 * (`stillOpen`, `workflow_decisions_run_status_idx`). One past its
 * deadline that the run hasn't timed out yet doesn't count: nobody can
 * answer it, and the run goes on by itself once it times it out.
 */
export const hasOpenDecision = (now: Date): SQL => sql`EXISTS (
  SELECT 1 FROM ${workflowDecisions}
  WHERE ${workflowDecisions.runId} = ${workflowRuns.id}
    AND ${stillOpen(workflowDecisions, now)}
)`;

/**
 * That an App's run waits at `now`: it hasn't ended, and a decision of its
 * is open.
 */
export const waits = (now: Date): SQL =>
  sql`(${runUnended()} AND ${hasOpenDecision(now)})`;

/** That an App's run asked a person for a decision, at any time. */
const asked = (): SQL => sql`EXISTS (
  SELECT 1 FROM ${workflowDecisions}
  WHERE ${workflowDecisions.runId} = ${workflowRuns.id}
)`;

/**
 * The runs of `scope`'s independent workflows: every run of `workflows`,
 * `principal`'s alone of `ownWorkflows`. Undefined when it holds none.
 */
const resourceRunsSeen = (scope: RunScope, workflow: SQL): SQL | undefined => {
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
 * The selects of the view's arms, each narrowed by `where`, either
 * undefined when it can hold no run: see `runView`.
 */
const armsOf = (
  db: DrizzleD1Database,
  scope: RunScope,
  now: Date,
  where: RunWhere | undefined,
  ordered: boolean
) => {
  // `+column` is never looked up by an index (overview.ts says more).
  const scoped = (column: SQL): SQL => (ordered ? sql`+${column}` : column);
  const columns = (
    arm: RunArm,
    goesOn: SQL,
    waitsNow: SQL,
    everAsked: SQL
  ) => ({
    kind: sql<RunArm["kind"]>`${arm.kind}`.as("view_kind"),
    id: sql<string>`${arm.id}`.as("view_id"),
    app: sql<string | null>`${arm.app}`.as("view_app"),
    workflow: sql<string>`${arm.workflow}`.as("view_workflow"),
    principal: sql<string | null>`${arm.principal}`.as("view_principal"),
    status: sql<RunRow["status"]>`${arm.status}`.as("view_status"),
    createdAt: sql<number>`${arm.createdAt}`.as("view_created_at"),
    endedAt: sql<number | null>`${arm.endedAt}`.as("view_ended_at"),
    unended: sql<number>`${goesOn}`.as("view_unended"),
    waits: sql<number>`${waitsNow}`.as("view_waits"),
    asked: sql<number>`${everAsked}`.as("view_asked"),
  });
  const appWhere = scope.apps.length === 0 ? false : where?.(appArm);
  const app =
    appWhere === false
      ? undefined
      : db
          .select(columns(appArm, runUnended(), waits(now), asked()))
          .from(workflowRuns)
          .where(
            and(
              sql`${scoped(sql`${workflowRuns.appId}`)} IN ${listOf(scope.apps)}`,
              appWhere
            )
          )
          .$dynamic();
  const seen = resourceRunsSeen(
    scope,
    scoped(sql`${workflowResourceRuns.workflowResourceId}`)
  );
  const resourceWhere = seen === undefined ? false : where?.(resourceArm);
  const resource =
    resourceWhere === false
      ? undefined
      : db
          .select(
            columns(
              resourceArm,
              sql`${workflowResourceRuns.endedAt} IS NULL`,
              sql`0`,
              sql`0`
            )
          )
          .from(workflowResourceRuns)
          .where(and(seen, resourceWhere))
          .$dynamic();
  return { app, resource };
};

/**
 * The runs `scope` sees, each arm narrowed by `where`, as one subquery
 * named `run`, its columns named `view_…` so a join never mistakes them for
 * another table's: its kind (`app`, `resource`), ID, App (null for an
 * independent workflow's), workflow (an App's workflow ID, or the
 * independent workflow's), the person it acts for (null for an App's run a
 * trigger started), status, when it started and ended (Unix milliseconds),
 * whether it goes on (it hasn't ended, and nobody asked to cancel an App's
 * run), and whether it waits at `now` for a decision, or ever asked for
 * one. Undefined when no arm can hold a run. What reads it groups and
 * counts; a list in an order reads `orderedRuns`.
 *
 * Each arm finds the runs of its Apps or workflows by their own index
 * (`workflow_runs_app_idx`, `workflow_resource_runs_newest_idx`), unless
 * `ordered`: then which App or workflow a run is of is checked, never
 * looked up, so an arm reads the index its condition wants.
 *
 * An independent workflow's run waits for no decision: its decisions come
 * with GRA-941, and with them its arm's `waits` and `asked`.
 */
export const runView = (
  db: DrizzleD1Database,
  scope: RunScope,
  now: Date,
  where?: RunWhere,
  ordered = false
) => {
  const { app, resource } = armsOf(db, scope, now, where, ordered);
  if (app === undefined) {
    return resource?.as("run");
  }
  return (resource === undefined ? app : app.unionAll(resource)).as("run");
};

/**
 * How a list orders runs: newest first by start, then ID; by start alone
 * (one App's, whose index holds no ID); or latest ended first, then ID.
 */
export type RunOrder = "newest" | "byStart" | "latestEnded";

/** A run as `orderedRuns` lists it. */
export interface OrderedRun {
  kind: RunArm["kind"];
  id: string;
  createdAt: number;
  endedAt: number | null;
}

/** The terms `order` sorts an arm's rows by, latest first. */
const orderOf = (arm: RunArm, order: RunOrder): SQL[] => {
  if (order === "byStart") {
    return [sql`${arm.createdAt} DESC`];
  }
  return [
    sql`${order === "newest" ? arm.createdAt : arm.endedAt} DESC`,
    sql`${arm.id} DESC`,
  ];
};

/** Whether `a` comes after `b` in `order`: how merged arms sort. */
const compared = (a: OrderedRun, b: OrderedRun, order: RunOrder): number => {
  const key = (run: OrderedRun) =>
    order === "latestEnded" ? (run.endedAt ?? 0) : run.createdAt;
  if (key(a) !== key(b) || order === "byStart") {
    return key(b) - key(a);
  }
  // By ID as SQLite compares text: byte by byte, not by locale.
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
};

/**
 * The first `limit` runs `scope` sees, narrowed by `where`, in `order`:
 * each arm reads the index of its own order and stops at `limit`, and
 * their pages are merged, so no list sorts every run it might show. Which
 * App or workflow a run is of is checked, never looked up (`ordered`).
 */
export const orderedRuns = async (
  db: DrizzleD1Database,
  scope: RunScope,
  now: Date,
  where: RunWhere,
  order: RunOrder,
  limit: number
): Promise<OrderedRun[]> => {
  const { app, resource } = armsOf(db, scope, now, where, true);
  const pages = await Promise.all([
    app?.orderBy(...orderOf(appArm, order)).limit(limit) ?? [],
    resource?.orderBy(...orderOf(resourceArm, order)).limit(limit) ?? [],
  ]);
  return pages
    .flat()
    .map(({ kind, id, createdAt, endedAt }) => ({
      kind,
      id,
      createdAt,
      endedAt,
    }))
    .toSorted((a, b) => compared(a, b, order))
    .slice(0, limit);
};
