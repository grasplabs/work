import { workflowPaths } from "@grasp-os/compiler";
import { describeWorkflow } from "@grasp-os/sdk/describe";
import type { AppFiles } from "@grasp-os/shared/apps";
import { deploymentConfig } from "@grasp-os/shared/config";
import { inboundMailDomainSchema } from "@grasp-os/shared/deployment-config";
import { messageOf } from "@grasp-os/shared/errors";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import {
  defaultTimeZone,
  failedRunDays,
  handledRunDays,
  maxFailedStarts,
  runFilterStatuses,
  runsPageSize,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type {
  AppListedRun,
  AppWorkflowSummary,
  LatestRun,
  ListedRun,
  OutlineNode,
  ResourceWorkflowSummary,
  RunFilterStatus,
  RunsPage,
  RunStatus,
  WorkflowDetail,
  WorkflowDryRun,
  WorkflowSummary,
  WorkflowTrigger,
} from "@grasp-os/shared/workflows";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { appsBuiltBy } from "../app-access.ts";
import { appFor, versionFiles } from "../apps.ts";
import type { Member } from "../auth/identity.ts";
import {
  users,
  workflowDecisions,
  workflowResourceRuns,
  workflowRuns,
  workflowTriggers,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { answerableBy, stillOpen } from "../decisions/decisions.ts";
import { queuedRuns } from "./admission.ts";
import { declaredParams, dryRunTests, hasWorkflow } from "./code.ts";
import { ownerKey, ownersSet, setWorkflowOwner } from "./owners.ts";
import { paramValues } from "./param-values.ts";
import { listParams } from "./params.ts";
import type { RunRow as ResourceRunRow } from "./resource-runs.ts";
import {
  hasOpenDecision,
  listOf,
  orderedRuns,
  runUnended,
  runView,
  scopeOf,
  visibleApps,
  visibleToMember,
  waits,
} from "./run-view.ts";
import type {
  ListedApp,
  RunArm,
  RunOrder,
  RunScope,
  RunWhere,
} from "./run-view.ts";
import {
  goesOn,
  queuedRun,
  runFor,
  shownStatus,
  unended,
  workflowInputSchema,
} from "./runs.ts";
import type { RunRow } from "./runs.ts";

// Every workflow a person can see, an App's or an independent one, and
// their runs: the Workflows page, its Runs tab and the workflow view. A
// person sees the workflows and runs of every App they can open
// (app-access.ts), and the independent workflows they have a role in, with
// the runs their pages list them: every run for a builder, their own for a
// user (run-view.ts). What each App's run shows them is what `list` shows
// for one App (`runFor`); an independent workflow's run, what its page
// lists of it.
//
// A run waits when it hasn't ended and one of its decisions is still
// open, as answering decides it (`stillOpen`): open, and not past its
// deadline. It goes on once someone answers it, on the decision's own
// page. A run that waits otherwise (a sleep, a feature switched
// off, a decision past its deadline that it hasn't timed out yet) goes on
// by itself, and counts as running. Only an App's runs ask for decisions
// yet (run-view.ts).
//
// A run that goes on without a decision to wait for, while a step of it
// waits in the client's queue for a share of the attempts running at
// once, shows as queued (admission.ts, `queuedRuns`), with the share and
// when it asks again: its own place alone, never who else waits. The
// Running filter lists it: throttling, not a failure.
//
// The queries are written for a D1 without statistics (a fresh one never
// has them), where SQLite picks indexes by the query's shape alone. Each
// list reads one index in the order it returns rows, and stops at a page:
// runs newest first by `workflow_runs_created_idx` and
// `workflow_resource_runs_created_idx`, failed runs by their tables'
// `status_ended` indexes, waiting runs from the open decisions
// (`workflow_decisions_status_opened_idx`), one App's runs by its own
// (`workflow_runs_app_idx`, `workflow_runs_app_workflow_idx`), runs that
// haven't ended by status. A filter that must not pick an index of its
// own is written `+column`, which SQLite never looks up by an index: so
// the list of Apps and workflows someone sees never turns a page into a
// sort of every run of them. workflow-overview.test.ts checks the plans.

type Db = DrizzleD1Database;

const dayMs = 24 * 60 * 60 * 1000;

const invalid = () => workflowErrors.create("workflow.invalid");

/** That a run is one of the Apps `ids`, never looked up by an index. */
const ofApps = (ids: readonly string[]): SQL =>
  sql`+${workflowRuns.appId} IN ${listOf(ids)}`;

interface AppWorkflow {
  app: ListedApp;
  workflow: WorkflowId;
}

/**
 * The workflows of each released App's current version, by App, then ID,
 * as the version's row keeps them: no files are read.
 */
const workflowsOf = (listed: readonly ListedApp[]): AppWorkflow[] =>
  listed.flatMap((app) =>
    app.currentVersion === null
      ? []
      : app.workflows
          .toSorted()
          .map((id) => ({ app, workflow: workflowIdSchema.parse(id) }))
  );

/**
 * A key of a workflow, for looking its runs up: an App's by its App and
 * ID, an independent one by its ID alone (as the run view has it, its App
 * null).
 */
const keyOf = (app: string | null, workflow: string): string =>
  JSON.stringify([app, workflow]);

/** Counts by workflow, as the grouped queries return them. */
const countsByKey = (
  rows: readonly { app: string | null; workflow: string; count: number }[]
): Map<string, number> =>
  new Map(
    rows.map(({ app, workflow, count }) => [keyOf(app, workflow), count])
  );

const latestRunSchema = z.object({
  id: z.string(),
  app: z.string().nullable(),
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
 * Each of `workflows`' latest run: one query, which looks each workflow's
 * latest run up in `workflow_runs_app_workflow_idx`, read newest first and
 * stopped at one, so it reads one run a workflow however many runs each
 * has. (Ranking every run of the Apps in a window instead reads, and
 * sorts, them all.) Runs started in the same millisecond are told apart
 * by no one: either counts as the latest.
 */
const latestAppRuns = async (
  db: Db,
  workflows: readonly AppWorkflow[],
  now: Date
): Promise<LatestRow[]> => {
  if (workflows.length === 0) {
    return [];
  }
  const pairs = JSON.stringify(
    workflows.map(({ app, workflow }) => [app.id, workflow])
  );
  const rows = await db.all(sql`
    SELECT latest.id, latest.app_id AS app, latest.workflow_id AS workflow,
      latest.status, latest.created_at AS createdAt,
      (latest.status IN ${listOf(unended)} AND EXISTS (
        SELECT 1 FROM ${workflowDecisions}
        WHERE ${workflowDecisions.runId} = latest.id
          AND ${stillOpen(workflowDecisions, now)}
      )) AS waits
    FROM json_each(${pairs}) AS wanted
    INNER JOIN ${workflowRuns} AS latest ON latest.id = (
      SELECT id FROM ${workflowRuns}
      WHERE app_id = wanted.value ->> 0
        AND workflow_id = wanted.value ->> 1
      ORDER BY created_at DESC
      LIMIT 1
    )`);
  return z.array(latestRunSchema).parse(rows);
};

/**
 * Each of the independent workflows `workflows`' latest run of those `by`
 * sees: any run of one they build, their own of one they use. One query,
 * which looks each up in `workflow_resource_runs_newest_idx` newest first
 * and stops at one, as for an App's.
 */
const latestResourceRuns = async (
  db: Db,
  by: Member,
  workflows: readonly WorkflowResource[]
): Promise<LatestRow[]> => {
  if (workflows.length === 0) {
    return [];
  }
  const wanted = JSON.stringify(
    workflows.map(({ id, role }) => [id, role === "builder" ? null : by.userId])
  );
  const runs = workflowResourceRuns;
  const rows = await db.all(sql`
    SELECT latest.id, NULL AS app,
      latest.workflow_resource_id AS workflow, latest.status,
      latest.created_at AS createdAt, 0 AS waits
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
 * The latest runs `rows` by workflow key: `waiting` while one waits for a
 * decision; one that goes on otherwise may wait for a share of the
 * attempts running at once.
 */
const latestByKey = async (
  db: Db,
  rows: readonly LatestRow[],
  now: Date
): Promise<Map<string, LatestRun>> => {
  const queues = await queuedRuns(
    db,
    rows.flatMap(({ id, status, waits: waiting }) =>
      goesOn(status) && waiting !== 1 ? [id] : []
    ),
    now.getTime()
  );
  return new Map(
    rows.map((row) => {
      const status: RunStatus =
        row.waits === 1 ? "waiting" : shownStatus(row.status);
      const queue = queues.get(row.id);
      return [
        keyOf(row.app, row.workflow),
        {
          id: runIdSchema.parse(row.id),
          ...(status === "running" && queue !== undefined
            ? { status: "queued", queued: queue }
            : { status }),
          createdAt: new Date(row.createdAt).toISOString(),
        },
      ];
    })
  );
};

/**
 * The runs `scope` sees that ended `status` since `since`, counted by
 * workflow key: read from the runs ended since, by their tables'
 * `status_ended` indexes.
 */
const endedSince = async (
  db: Db,
  scope: RunScope,
  status: "completed" | "failed",
  since: Date,
  now: Date
): Promise<Map<string, number>> => {
  const run = runView(
    db,
    scope,
    now,
    (arm) =>
      sql`${arm.status} = ${status} AND ${arm.endedAt} >= ${since.getTime()}`,
    true
  );
  if (run === undefined) {
    return new Map();
  }
  const rows = await db
    .select({
      app: run.app,
      workflow: run.workflow,
      count: sql<number>`count(*)`,
    })
    .from(run)
    .groupBy(sql`${run.app}`, sql`${run.workflow}`);
  return countsByKey(rows);
};

/**
 * The runs of the Apps `appIds` waiting for a decision now, by workflow
 * key: counted from the open decisions.
 */
const waitingByWorkflow = async (
  db: Db,
  appIds: readonly string[],
  now: Date
): Promise<Map<string, number>> => {
  if (appIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      app: workflowRuns.appId,
      workflow: workflowRuns.workflowId,
      count: sql<number>`count(DISTINCT ${workflowRuns.id})`,
    })
    .from(workflowDecisions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
    .where(and(stillOpen(workflowDecisions, now), runUnended(), ofApps(appIds)))
    .groupBy(workflowRuns.appId, workflowRuns.workflowId);
  return countsByKey(rows);
};

/**
 * What an App's workflows show besides their runs: the schedules that
 * stopped (by key and version), their owners (owners.ts), and the Apps `by`
 * builds, who may change them.
 */
const appExtrasOf = async (env: Env, by: Member, appIds: readonly string[]) => {
  if (appIds.length === 0) {
    return {
      stopped: new Set<string>(),
      owners: new Map<string, { userId: string; name: string | null }>(),
      built: new Set<string>(),
    };
  }
  const [stopped, owners, built] = await Promise.all([
    // The Apps' triggers, by the index that starts with their App.
    drizzle(env.DB)
      .select({
        app: workflowTriggers.appId,
        workflow: workflowTriggers.workflowId,
        version: workflowTriggers.version,
      })
      .from(workflowTriggers)
      .where(
        and(
          sql`${workflowTriggers.appId} IN ${listOf(appIds)}`,
          eq(workflowTriggers.type, "schedule"),
          gte(workflowTriggers.failedStarts, maxFailedStarts)
        )
      ),
    ownersSet(env, appIds),
    // Staff change no owner (owners.ts), so whether they build is moot.
    by.staff ? new Set<string>() : appsBuiltBy(env, by, appIds),
  ]);
  return {
    stopped: new Set(
      stopped.map((row) => `${keyOf(row.app, row.workflow)}@${row.version}`)
    ),
    owners,
    built,
  };
};

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

/** What each workflow's summary counts, by workflow key. */
interface SummaryCounts {
  latest: Map<string, LatestRun>;
  waiting: Map<string, number>;
  failed: Map<string, number>;
  handled: Map<string, number>;
}

/**
 * The summaries of `workflows` (of Apps) and `resources` (independent),
 * for `by`: each one's owner (owners.ts for an App's), latest run, its
 * runs waiting now (counted from the open decisions), those failed lately
 * and those it handled this week (from the runs ended since), and, for an
 * App's, whether a schedule of it stopped (triggers.ts) and whether `by`
 * may change its owner: a fixed number of queries, whatever the number of
 * workflows.
 */
const summariesOf = async (
  env: Env,
  by: Member,
  workflows: readonly AppWorkflow[],
  resources: readonly WorkflowResource[]
): Promise<{
  apps: AppWorkflowSummary[];
  resources: ResourceWorkflowSummary[];
}> => {
  if (workflows.length === 0 && resources.length === 0) {
    return { apps: [], resources: [] };
  }
  const db = drizzle(env.DB);
  const appIds = [...new Set(workflows.map(({ app }) => app.id))];
  const scope = scopeOf(by, appIds, resources);
  const now = new Date();
  const failedSince = new Date(now.getTime() - failedRunDays * dayMs);
  const handledSince = new Date(now.getTime() - handledRunDays * dayMs);
  const [
    latestApps,
    latestResources,
    waiting,
    failed,
    handled,
    appExtras,
    resourceOwners,
  ] = await Promise.all([
    latestAppRuns(db, workflows, now),
    latestResourceRuns(db, by, resources),
    waitingByWorkflow(db, appIds, now),
    endedSince(db, scope, "failed", failedSince, now),
    endedSince(db, scope, "completed", handledSince, now),
    appExtrasOf(env, by, appIds),
    ownerNames(
      db,
      resources.map(({ owner }) => owner)
    ),
  ]);
  const counts: SummaryCounts = {
    latest: await latestByKey(db, [...latestApps, ...latestResources], now),
    waiting,
    failed,
    handled,
  };
  const countsOf = (key: string) => ({
    lastRun: counts.latest.get(key) ?? null,
    waiting: counts.waiting.get(key) ?? 0,
    failed: counts.failed.get(key) ?? 0,
    handled: counts.handled.get(key) ?? 0,
  });
  return {
    apps: workflows.map(({ app, workflow }) => ({
      type: "app",
      app: app.id,
      appName: app.name,
      workflow,
      version: app.currentVersion ?? 0,
      owner: appExtras.owners.get(ownerKey(app.id, workflow)) ?? {
        userId: app.ownerId,
        name: app.ownerName,
      },
      changesOwner: appExtras.built.has(app.id),
      ...countsOf(keyOf(app.id, workflow)),
      // Of the current version: only its triggers start runs.
      scheduleStopped: appExtras.stopped.has(
        `${keyOf(app.id, workflow)}@${app.currentVersion}`
      ),
    })),
    resources: resources.map((resource) => ({
      type: "resource",
      workflowId: workflowResourceIdSchema.parse(resource.id),
      name: resource.name,
      version: resource.currentVersion,
      owner: {
        userId: resource.owner,
        name: resourceOwners.get(resource.owner) ?? null,
      },
      ...countsOf(keyOf(null, resource.id)),
    })),
  };
};

/**
 * Every workflow of the current version of every App `by` can open, by
 * App name, then workflow, then every independent workflow they have a
 * role in, by name.
 */
export const workflowOverview = async (
  env: Env,
  by: Member
): Promise<WorkflowSummary[]> => {
  const visible = await visibleToMember(env, by);
  const summaries = await summariesOf(
    env,
    by,
    workflowsOf(visible.apps),
    visible.workflows
  );
  return [...summaries.apps, ...summaries.resources];
};

/**
 * The workflows of the current version of every App `by` can open that
 * `keep` keeps, left out before they are summed up, by App name, then
 * workflow.
 */
export const appWorkflowOverview = async (
  env: Env,
  by: Member,
  keep: (app: string, workflow: string) => boolean
): Promise<AppWorkflowSummary[]> => {
  const summaries = await summariesOf(
    env,
    by,
    workflowsOf(await visibleApps(env, by)).filter(({ app, workflow }) =>
      keep(app.id, workflow)
    ),
    []
  );
  return summaries.apps;
};

const runFilterSchema = z
  .strictObject({
    app: appIdSchema.optional(),
    workflow: workflowInputSchema.optional(),
    status: z.enum(runFilterStatuses).optional(),
  })
  .optional();

/** A run a list found, its row as its table keeps it. */
type FoundRun =
  | {
      kind: "app";
      row: RunRow;
      /** The decision it waits for, as read from the open decisions. */
      decision: { id: string; deciders: string } | null;
    }
  | { kind: "resource"; row: ResourceRunRow };

/** One more than a page: whether there are more tells itself. */
const pageAndOne = runsPageSize + 1;

/**
 * Runs waiting for a decision, matching `where`, latest to wait first:
 * read from the open decisions, each run once, with its latest open
 * decision; a page and one. Only an App's runs wait for one yet.
 */
const waitingRuns = async (
  db: Db,
  where: SQL | undefined,
  now: Date
): Promise<FoundRun[]> => {
  const later = alias(workflowDecisions, "later");
  const rows = await db
    .select({
      run: workflowRuns,
      decision: {
        id: workflowDecisions.id,
        deciders: workflowDecisions.deciders,
      },
    })
    .from(workflowDecisions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
    .where(
      and(
        stillOpen(workflowDecisions, now),
        runUnended(),
        // Its latest open decision alone, so each run comes once.
        notExists(
          db
            .select({ one: sql`1` })
            .from(later)
            .where(
              and(
                eq(later.runId, workflowDecisions.runId),
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
        ),
        where
      )
    )
    .orderBy(desc(workflowDecisions.openedAt), desc(workflowDecisions.id))
    .limit(pageAndOne);
  return rows.map(({ run, decision }) => ({ kind: "app", row: run, decision }));
};

/**
 * The first page and one of the runs `scope` sees, as `where` narrows the
 * view's arms, in `order` (run-view.ts, `orderedRuns`), with their rows:
 * the view lists them, and each table then gives its own by ID.
 */
const viewRuns = async (
  db: Db,
  scope: RunScope,
  now: Date,
  where: RunWhere,
  order: RunOrder
): Promise<FoundRun[]> => {
  const listed = await orderedRuns(db, scope, now, where, order, pageAndOne);
  const idsOf = (kind: "app" | "resource") =>
    listed.flatMap((row) => (row.kind === kind ? [row.id] : []));
  const [appRows, resourceRows] = await Promise.all([
    idsOf("app").length === 0
      ? []
      : db
          .select()
          .from(workflowRuns)
          .where(inList(workflowRuns.id, idsOf("app"))),
    idsOf("resource").length === 0
      ? []
      : db
          .select()
          .from(workflowResourceRuns)
          .where(inList(workflowResourceRuns.id, idsOf("resource"))),
  ]);
  const found = new Map<string, FoundRun>([
    ...appRows.map((row): [string, FoundRun] => [
      row.id,
      { kind: "app", row, decision: null },
    ]),
    ...resourceRows.map((row): [string, FoundRun] => [
      row.id,
      { kind: "resource", row },
    ]),
  ]);
  return listed.flatMap(({ id }) => {
    const one = found.get(id);
    return one === undefined ? [] : [one];
  });
};

/**
 * For each of the waiting runs `runIds`, the latest of its open decisions
 * `by` may answer now (`answerableBy`), if any: one read of their open
 * decisions (`workflow_decisions_run_status_idx`).
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
      runId: workflowDecisions.runId,
      deciders: workflowDecisions.deciders,
    })
    .from(workflowDecisions)
    .where(
      and(
        sql`${workflowDecisions.runId} IN ${listOf(runIds)}`,
        stillOpen(workflowDecisions, now)
      )
    )
    .orderBy(desc(workflowDecisions.openedAt), desc(workflowDecisions.id));
  const answerable = await answerableBy(env, by, open);
  const byRun = new Map<string, string>();
  for (const { id, runId } of open) {
    // Each an App's run's, read by its ID.
    if (runId !== null && answerable.has(id) && !byRun.has(runId)) {
      byRun.set(runId, id);
    }
  }
  return byRun;
};

/**
 * Runs `by` can see, as `input` (a `RunFilter`) narrows them: waiting
 * first, then failed (latest ended first), then the rest, newest first;
 * at most a page, and whether more matched. A run waiting for a decision
 * says so (`waiting`), with the decision when `by` may answer it now. An
 * App or a workflow in the filter names an App's runs: no independent
 * workflow's run matches it.
 */
export const listAllRuns = async (
  env: Env,
  by: Member,
  input?: unknown
): Promise<RunsPage> => {
  const parsed = runFilterSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid();
  }
  const filter = parsed.data ?? {};
  if (filter.app !== undefined) {
    // As for one App's runs: an App they can't open isn't there.
    await appFor(env, by, filter.app, "user");
  }
  const visible = await visibleToMember(env, by);
  const owners = new Map<string, string>(
    visible.apps.flatMap(({ id, ownerId }) =>
      filter.app === undefined || id === filter.app ? [[id, ownerId]] : []
    )
  );
  if (filter.app !== undefined && !owners.has(filter.app)) {
    // One they can't open any more, since the check above.
    return { runs: [], more: false };
  }
  const appNames = new Map<string, string>(
    visible.apps.map(({ id, name }) => [id, name])
  );
  const workflowNames = new Map<string, string>(
    visible.workflows.map(({ id, name }) => [id, name])
  );
  const scope: RunScope = { ...visible.scope, apps: [...owners.keys()] };
  // An App or its workflow names an App's runs alone.
  const appsOnly = filter.app !== undefined || filter.workflow !== undefined;
  const workflowIs = (checkedOnly: boolean): SQL | undefined => {
    if (filter.workflow === undefined) {
      return undefined;
    }
    return checkedOnly
      ? sql`+${workflowRuns.workflowId} = ${filter.workflow}`
      : eq(workflowRuns.workflowId, filter.workflow);
  };
  // The rest newest first: across Apps and workflows by their
  // `created_idx`, for one App by its own runs (`workflow_runs_app_idx`,
  // or with a workflow `workflow_runs_app_workflow_idx`), which hold them
  // newest first by start alone: runs started in the same millisecond
  // come in either order.
  const oneApp = filter.app;
  /**
   * `condition` on an arm, as the filter narrows it: an App's runs by
   * their workflow, and for one App by its own index; an independent
   * workflow's not at all once the filter names an App or a workflow.
   * `indexed` an arm reads by `condition`'s own index, which the App and
   * workflow then only narrow down.
   */
  const narrowed = (arm: RunArm, condition: SQL, indexed = false) => {
    if (arm.kind === "resource") {
      return appsOnly ? false : condition;
    }
    if (indexed || oneApp === undefined) {
      return sql`${condition} AND ${workflowIs(true) ?? sql`1`}`;
    }
    return sql`${condition} AND ${eq(workflowRuns.appId, oneApp)} AND ${workflowIs(false) ?? sql`1`}`;
  };
  const newest: RunOrder = oneApp === undefined ? "newest" : "byStart";
  const db = drizzle(env.DB);
  const now = new Date();
  const byStatus: Record<RunFilterStatus, () => Promise<FoundRun[]>> = {
    // Read from the open decisions, which the App and workflow only
    // narrow down.
    waiting: async () =>
      scope.apps.length === 0
        ? []
        : await waitingRuns(db, and(ofApps(scope.apps), workflowIs(true)), now),
    // Read from the failed runs by end, as above.
    failed: async () =>
      await viewRuns(
        db,
        scope,
        now,
        (arm) => narrowed(arm, sql`${arm.status} = 'failed'`, true),
        "latestEnded"
      ),
    // By status: runs that haven't ended are few, so sorting them costs
    // little.
    running: async () =>
      await viewRuns(
        db,
        scope,
        now,
        (arm) =>
          narrowed(
            arm,
            arm.kind === "app"
              ? sql`${inArray(workflowRuns.status, unended)} AND NOT ${hasOpenDecision(now)}`
              : sql`${arm.status} IN ${listOf(unended)}`
          ),
        newest
      ),
    done: async () =>
      await viewRuns(
        db,
        scope,
        now,
        (arm) =>
          narrowed(arm, sql`+${arm.status} IN ('completed', 'cancelled')`),
        newest
      ),
  };
  const rest = async () =>
    await viewRuns(
      db,
      scope,
      now,
      (arm) =>
        narrowed(
          arm,
          arm.kind === "app"
            ? sql`+${workflowRuns.status} <> 'failed' AND NOT ${waits(now)}`
            : sql`+${arm.status} <> 'failed'`
        ),
      newest
    );
  const pages =
    filter.status === undefined
      ? await Promise.all([byStatus.waiting(), byStatus.failed(), rest()])
      : [await byStatus[filter.status]()];
  const matched = pages.flat();
  const found = matched.slice(0, runsPageSize);
  const [answering, queues] = await Promise.all([
    answerableDecisions(
      env,
      db,
      by,
      found.flatMap((run) =>
        run.kind === "app" && run.decision !== null ? [run.row.id] : []
      ),
      now
    ),
    // A run waiting for a decision says so; one that goes on otherwise
    // may wait for a share of the attempts running at once.
    queuedRuns(
      db,
      found.flatMap((run) =>
        (run.kind === "resource" || run.decision === null) &&
        goesOn(run.row.status)
          ? [run.row.id]
          : []
      ),
      now.getTime()
    ),
  ]);
  return {
    runs: found.map((run): ListedRun => {
      if (run.kind === "resource") {
        const { row } = run;
        return queuedRun(
          {
            type: "resource",
            id: runIdSchema.parse(row.id),
            workflowId: workflowResourceIdSchema.parse(row.workflowResourceId),
            name: workflowNames.get(row.workflowResourceId) ?? "",
            version: row.version,
            startedBy: { type: "person", userId: row.principalId },
            status: shownStatus(row.status),
            createdAt: row.createdAt.toISOString(),
            endedAt: row.endedAt?.toISOString() ?? null,
          },
          queues.get(row.id)
        );
      }
      const { row, decision } = run;
      const listed: AppListedRun = {
        ...runFor(env, by, row, owners.get(row.appId) ?? ""),
        type: "app",
        appName: appNames.get(row.appId) ?? "",
      };
      if (decision === null) {
        return queuedRun(listed, queues.get(row.id));
      }
      const answered = answering.get(row.id);
      return answered === undefined
        ? { ...listed, status: "waiting" }
        : { ...listed, status: "waiting", decision: answered };
    }),
    more: matched.length > runsPageSize,
  };
};

/**
 * The outline without its code, for someone who doesn't build the App:
 * each step's description, name and kind, and the branches and loops
 * around them, without their conditions, heads, keys, parameters read or
 * literal options.
 */
const withoutCode = (nodes: readonly OutlineNode[]): OutlineNode[] =>
  nodes.map((node): OutlineNode => {
    if (node.type === "step") {
      const { key: _key, ...step } = node;
      return { ...step, params: [], options: {}, code: "" };
    }
    if (node.type === "loop") {
      return {
        ...node,
        header: "",
        params: [],
        steps: withoutCode(node.steps),
      };
    }
    return {
      ...node,
      condition: "",
      params: [],
      steps: withoutCode(node.steps),
      otherwise: withoutCode(node.otherwise),
    };
  });

/** Whether `by` builds App `app`: the check a builder's call makes. */
const buildsApp = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<boolean> => {
  try {
    await appFor(env, by, app, "builder");
    return true;
  } catch (error) {
    if (roleErrors.codeOf(error) === "role.forbidden") {
      return false;
    }
    throw error;
  }
};

/** A workflow's steps as its code reads, or why they can't be read. */
const stepsOf = (
  files: AppFiles,
  workflow: WorkflowId
): WorkflowDetail["steps"] => {
  try {
    return {
      ok: true,
      outline: describeWorkflow(files[workflowPaths(workflow).workflow] ?? ""),
    };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
};

/**
 * The domain the deployment receives mail at (`INBOUND_MAIL_DOMAIN`), set
 * up outside core with Email Routing; undefined while it is unset, or set
 * to something that isn't a domain (logged as `config.invalid`).
 */
const inboundMailDomain = (
  env: Pick<Env, "INBOUND_MAIL_DOMAIN">
): string | undefined => {
  const raw = env.INBOUND_MAIL_DOMAIN;
  // A string var: the console sets it as JSON, which arrives parsed (a
  // bare string), and `wrangler dev --var` as text, which may or may not be
  // JSON. Either way a bare domain is read as the JSON string it is.
  return deploymentConfig(
    inboundMailDomainSchema,
    "INBOUND_MAIL_DOMAIN",
    typeof raw === "string" && !raw.startsWith('"') ? JSON.stringify(raw) : raw
  );
};

/**
 * The triggers workflow `workflow` of App `app` has at `version`, in the
 * order its code declares them: the rows the version registered as it
 * was made current (trigger-registry.ts), from declarations checked then,
 * so its code isn't read or run again to show them.
 */
const registeredTriggers = async (
  env: Env,
  app: AppId,
  version: number,
  workflow: WorkflowId
): Promise<WorkflowTrigger[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.appId, app),
        eq(workflowTriggers.version, version),
        eq(workflowTriggers.workflowId, workflow)
      )
    )
    .orderBy(asc(workflowTriggers.position));
  const domain = inboundMailDomain(env);
  return rows.flatMap((row): WorkflowTrigger[] => {
    switch (row.type) {
      case "schedule": {
        return row.param === null
          ? []
          : [
              {
                type: "schedule",
                position: row.position,
                param: row.param,
                timeZone: row.timeZone ?? defaultTimeZone,
                nextRunAt: row.nextRunAt?.toISOString() ?? null,
                stopped: row.failedStarts >= maxFailedStarts,
              },
            ];
      }
      case "email": {
        return row.address === null
          ? []
          : [
              {
                type: "email",
                position: row.position,
                localPart: row.address,
                address:
                  domain === undefined ? null : `${row.address}@${domain}`,
              },
            ];
      }
      case "event": {
        return row.event === null
          ? []
          : [{ type: "event", position: row.position, event: row.event }];
      }
      default: {
        return row.type satisfies never;
      }
    }
  });
};

/** A workflow of an App's current version, with the version's files. */
interface CurrentWorkflow {
  app: ListedApp;
  workflow: WorkflowId;
  version: number;
  files: AppFiles;
}

/**
 * Workflow `workflow` of App `app`'s current version, for `by` with at
 * least `needed` in the App.
 */
const currentWorkflow = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  needed: "user" | "builder"
): Promise<CurrentWorkflow> => {
  const found = await appFor(env, by, app, needed);
  const id = workflowInputSchema.safeParse(workflow);
  if (!id.success) {
    throw invalid();
  }
  const version = found.currentVersion;
  if (version === null) {
    throw workflowErrors.create("workflow.not_found");
  }
  const files = await versionFiles(env, found.id, version);
  if (!hasWorkflow(files, id.data)) {
    throw workflowErrors.create("workflow.not_found");
  }
  const owner = await drizzle(env.DB)
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, found.owner))
    .get();
  return {
    app: {
      id: found.id,
      name: found.name,
      ownerId: found.owner,
      ownerName: owner?.name ?? null,
      currentVersion: version,
      workflows: [],
    },
    workflow: id.data,
    version,
    files,
  };
};

/**
 * One workflow of an App's current version, for anyone with a role in the
 * App; its code (the outline's conditions, options and the like) and its
 * parameters only for its builders.
 */
export const workflowDetail = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown
): Promise<WorkflowDetail> => {
  const current = await currentWorkflow(env, by, app, workflow, "user");
  const [
    {
      apps: [summary],
    },
    builds,
    triggers,
  ] = await Promise.all([
    summariesOf(env, by, [current], []),
    buildsApp(env, by, current.app.id),
    registeredTriggers(env, current.app.id, current.version, current.workflow),
  ]);
  if (summary === undefined) {
    throw workflowErrors.create("workflow.not_found");
  }
  const steps = stepsOf(current.files, current.workflow);
  return {
    summary,
    steps:
      builds || !steps.ok
        ? steps
        : { ok: true, outline: { steps: withoutCode(steps.outline.steps) } },
    triggers,
    params: builds
      ? await listParams(env, by, current.app.id, current.workflow)
      : null,
    setsParams: builds && !by.staff,
  };
};

/**
 * Dry-runs a workflow's tests at its App's current version, with the
 * parameter values set now, as that version declares them; for the App's
 * builders. It makes no state changes, and records nothing.
 */
export const dryRunWorkflow = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown
): Promise<WorkflowDryRun> => {
  const current = await currentWorkflow(env, by, app, workflow, "builder");
  const { app: found, version, files } = current;
  const values = await paramValues(
    env,
    found.id,
    current.workflow,
    await declaredParams(env, found.id, version, current.workflow, files)
  );
  return {
    version,
    runs: await dryRunTests(
      env,
      found.id,
      version,
      current.workflow,
      files,
      Object.fromEntries(values)
    ),
  };
};

/**
 * Makes `owner` the owner of an App's workflow (owners.ts), for an admin
 * or a builder of the App, and returns the workflow's summary as it is
 * now.
 */
export const setOwner = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  owner: unknown
): Promise<AppWorkflowSummary> => {
  const set = await setWorkflowOwner(env, by, app, workflow, owner);
  const [summary] = await appWorkflowOverview(
    env,
    by,
    (id, workflowId) => id === set.app && workflowId === set.workflow
  );
  if (summary === undefined) {
    throw workflowErrors.create("workflow.not_found");
  }
  return summary;
};
