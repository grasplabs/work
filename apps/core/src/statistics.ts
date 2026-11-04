import { appErrors } from "@grasp-os/shared/apps";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { isPlatformMeasure } from "@grasp-os/shared/platform-measures";
import type { PlatformMeasure } from "@grasp-os/shared/platform-measures";
import {
  statisticErrors,
  statisticMaxApps,
  statisticMaxGroups,
  statisticQuerySchema,
} from "@grasp-os/shared/statistics";
import type {
  StatisticAnswer,
  StatisticGroup,
} from "@grasp-os/shared/statistics";
import { and, asc, count, eq, max, min, sql, sum } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { appFor } from "./apps.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { memberRole, teamsOf } from "./auth/identity.ts";
import {
  apps as appsTable,
  appWorkflowBindings,
  improvementSignalComputations,
  improvementSignals,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { authorize } from "./permissions.ts";
import { runView } from "./workflows/run-view.ts";

// The platform's statistics (@grasp-os/shared/statistics): the measures
// the platform publishes (`platform.` ones), read by an App's code through
// the platform's own functions (`permission.grasp`, resource-grasp.ts),
// only under a permission an admin grants it (`{ type: "platform" }`,
// action `statistics`), for Apps whose runs the person its call acts for
// may see added up: an admin, or a builder of that App, as for the
// improvement signals (signals-rpc.ts). They are worked out from the
// platform's own tables as they are read, by their indexes: counts and
// sums, never a run or who started it. Each read is audited, and each
// refused one with why. What an App reads here it may show to anyone who
// uses it, even people who can't open the counted App: the grant exists to
// publish these counts company-wide, and the admin's grant screen says so
// before they approve.
//
// An App's own measures are its own tables: `app_statistics` and
// `app_statistic_steps`, which held them before, are read and written by
// nothing now, and dropped in a later release (expand, then contract).

/** A day, in milliseconds. */
const dayMs = 24 * 60 * 60 * 1000;

/** The UTC day of `date`, `YYYY-MM-DD`. */
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/** A read, its input checked. */
type Query = z.output<typeof statisticQuerySchema>;

/** The values a row is grouped by, as one JSON array. */
const groupsOf = (grouped: readonly (SQL | SQLiteColumn)[]): SQL<string> =>
  sql<string>`json_array(${sql.join(
    grouped.length === 0 ? [sql`NULL`] : [...grouped],
    sql`, `
  )})`;

/** The values `groupsOf` gave a row. */
const groupValues = (json: string): (string | null)[] => {
  const parsed: unknown = JSON.parse(json);
  return z.array(z.string().nullable()).parse(parsed);
};

/** A group's values, as a query answers them: named, then added up. */
const groupRowSchema = z.object({
  groups: z.array(z.string().nullable()),
  count: z.number(),
  sum: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});

/**
 * The groups of `rows` (one past the most, to tell whether it truncated),
 * with each group's dimensions named as `groupBy` names them.
 */
const answerOf = (
  measure: string,
  from: string,
  to: string,
  groupBy: readonly string[],
  rows: readonly z.infer<typeof groupRowSchema>[]
): StatisticAnswer => {
  const groups: StatisticGroup[] = rows
    .slice(0, statisticMaxGroups)
    .map((row) => ({
      dimensions: Object.fromEntries(
        groupBy.map((name, index) => [name, row.groups[index] ?? null])
      ),
      count: row.count,
      sum: row.sum ?? 0,
      min: row.min ?? 0,
      max: row.max ?? 0,
    }));
  return {
    measure,
    from,
    to,
    groups,
    truncated: rows.length > statisticMaxGroups,
  };
};

/** A column a platform measure's dimension is read from. */
type Columns = Readonly<Record<string, SQLiteColumn>>;

/**
 * The runs of the Apps `apps` started from `start` to `now`, as `query`
 * asks: their own workflows' runs, by workflow ID, and the runs of the
 * independent workflows each binds now (`app_workflow_bindings`), by the
 * alias the App binds it under, whoever started them: the App's workflows,
 * whichever kind. Read through the run view (workflows/run-view.ts), each
 * arm by the index of its App's or workflow's runs.
 */
const workflowRunsMeasure = async (
  env: Env,
  apps: readonly string[],
  { where, groupBy, offset }: Query,
  start: Date,
  now: Date
) => {
  const db = drizzle(env.DB);
  const bindings = await db
    .select({ workflow: appWorkflowBindings.workflowResourceId })
    .from(appWorkflowBindings)
    .where(
      and(
        inList(appWorkflowBindings.appId, apps),
        eq(appWorkflowBindings.status, "active")
      )
    );
  const run = runView(
    db,
    {
      apps,
      workflows: [...new Set(bindings.map(({ workflow }) => workflow))],
      ownWorkflows: [],
      principal: "",
    },
    now,
    (arm) =>
      and(
        // An App's workflow by its own index; a bound one by its alias, below.
        arm.kind === "app" && where.workflow !== undefined
          ? sql`${arm.workflow} = ${where.workflow}`
          : undefined,
        sql`${arm.createdAt} >= ${start.getTime()}`,
        sql`${arm.createdAt} <= ${now.getTime()}`
      )
  );
  if (run === undefined) {
    return [];
  }
  // A bound workflow's run counts for each App binding it, under its alias.
  const bound = and(
    sql`${run.app} IS NULL`,
    eq(appWorkflowBindings.workflowResourceId, sql`${run.workflow}`),
    eq(appWorkflowBindings.status, "active"),
    inList(appWorkflowBindings.appId, apps)
  );
  const columns: Readonly<Record<string, SQL>> = {
    app: sql`coalesce(${run.app}, ${appWorkflowBindings.appId})`,
    workflow: sql`coalesce(${appWorkflowBindings.alias}, ${run.workflow})`,
  };
  const grouped = groupBy.flatMap((name) => columns[name] ?? []);
  const rows = await db
    .select({
      groups: groupsOf(grouped),
      count: count(),
    })
    .from(run)
    .leftJoin(appWorkflowBindings, bound)
    .where(
      and(
        sql`(${run.app} IS NOT NULL OR ${appWorkflowBindings.appId} IS NOT NULL)`,
        where.workflow === undefined
          ? undefined
          : sql`${columns.workflow} = ${where.workflow}`
      )
    )
    .groupBy(...grouped)
    // Without a group, no points still makes one row: none, then.
    .having(sql`count(*) > 0`)
    // By the groups' values, never their counts: pages stay put.
    .orderBy(...grouped.map((group) => asc(group)))
    .limit(statisticMaxGroups + 1)
    .offset(offset);
  // Each run is a point of value 1.
  return rows.map(({ groups, count: runs }) => ({
    groups: groupValues(groups),
    count: runs,
    sum: runs,
    min: 1,
    max: 1,
  }));
};

/**
 * The computation of improvement signals started last among those
 * finished by `end` (a read's `until`, or now): one subquery, so every
 * page of a read held at `until` reads the same computation, whatever
 * finishes after it.
 */
const latestFinishedBy = (end: Date): SQL => sql`(
  SELECT ${improvementSignalComputations.id} FROM ${improvementSignalComputations}
  WHERE ${improvementSignalComputations.finishedAt} IS NOT NULL
    AND ${improvementSignalComputations.finishedAt} <= ${end.getTime()}
  ORDER BY ${improvementSignalComputations.startedAt} DESC, ${improvementSignalComputations.id} DESC
  LIMIT 1
)`;

/**
 * The improvement signals of the Apps `apps` of the latest computation,
 * if it started within the window, from `start` to `now`, as `query`
 * asks; none while they are off.
 */
const signalsMeasure = async (
  env: Env,
  apps: readonly string[],
  { where, groupBy, offset }: Query,
  start: Date,
  now: Date
): Promise<{
  rows: z.infer<typeof groupRowSchema>[];
  computation: string | null;
}> => {
  const db = drizzle(env.DB);
  // Its computation's start, within the window.
  const inWindow = sql`${improvementSignalComputations.startedAt} >= ${start.getTime()} AND ${improvementSignalComputations.startedAt} <= ${now.getTime()}`;
  const columns: Columns = {
    app: improvementSignals.appId,
    workflow: improvementSignals.workflowId,
    kind: improvementSignals.kind,
  };
  const grouped = groupBy.flatMap((name) => columns[name] ?? []);
  const read = db
    .select({
      groups: groupsOf(grouped),
      count: count(),
      sum: sum(improvementSignals.value).mapWith(Number),
      min: min(improvementSignals.value),
      max: max(improvementSignals.value),
    })
    .from(improvementSignals)
    .where(
      and(
        eq(improvementSignals.computation, latestFinishedBy(now)),
        inList(improvementSignals.appId, apps),
        where.workflow === undefined
          ? undefined
          : eq(improvementSignals.workflowId, where.workflow),
        where.kind === undefined
          ? undefined
          : sql`${improvementSignals.kind} = ${where.kind}`,
        // Its computation's start, within the window, by its primary key.
        sql`EXISTS (SELECT 1 FROM ${improvementSignalComputations} WHERE ${improvementSignalComputations.id} = ${improvementSignals.computation} AND ${inWindow})`
      )
    )
    .groupBy(...grouped)
    // Without a group, no points still makes one row: none, then.
    .having(sql`count(*) > 0`)
    // By the groups' values, never their counts: pages stay put.
    .orderBy(...grouped.map((group) => asc(group)))
    .limit(statisticMaxGroups + 1)
    .offset(offset);
  // The computation it reads, in the same batch as its signals.
  const which = db
    .select({ id: improvementSignalComputations.id })
    .from(improvementSignalComputations)
    .where(
      and(eq(improvementSignalComputations.id, latestFinishedBy(now)), inWindow)
    );
  const [computations, rows] = await db.batch([which, read]);
  return {
    rows: rows.map((row) =>
      groupRowSchema.parse({ ...row, groups: groupValues(row.groups) })
    ),
    computation: computations[0]?.id ?? null,
  };
};

/** Refusals of `appFor` that make one App of many unavailable. */
const unavailableCodes: ReadonlySet<string> = new Set([
  "app.not_found",
  "role.forbidden",
]);

/**
 * Of the Apps `apps`, those whose runs the person `authority` acts for
 * may see added up (an admin, or a builder of it, `appFor`), and the rest,
 * which they may not see or which no longer exist. `permission.person_inactive`
 * for someone no longer a member.
 */
const runsVisible = async (
  env: Env,
  authority: Authority,
  apps: readonly string[]
): Promise<{ visible: string[]; unavailable: string[] }> => {
  const userId = authority.onBehalfOf;
  const role = await memberRole(env.DB, userId);
  if (!role) {
    throw permissionErrors.create("permission.person_inactive");
  }
  if (role === "admin") {
    const rows = await drizzle(env.DB)
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(inList(appsTable.id, apps));
    const existing = new Set(rows.map(({ id }) => id));
    return {
      visible: apps.filter((app) => existing.has(app)),
      unavailable: apps.filter((app) => !existing.has(app)),
    };
  }
  const member = { userId, role, teams: await teamsOf(env.DB, userId) };
  const visible: string[] = [];
  const unavailable: string[] = [];
  for (const app of apps) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few Apps, one at a time
      await appFor(env, member, app, "builder");
      visible.push(app);
    } catch (error) {
      if (!isExpectedError(error) || !unavailableCodes.has(error.code)) {
        throw error;
      }
      unavailable.push(app);
    }
  }
  return { visible, unavailable };
};

/**
 * Refuses a read of App `app`'s platform measures for the person
 * `authority` acts for unless they may see its runs added up, as `appFor`
 * does, without saying whether it exists.
 */
const requireRunsVisible = async (
  env: Env,
  authority: Authority,
  app: string
): Promise<void> => {
  const { unavailable } = await runsVisible(env, authority, [app]);
  if (unavailable.length > 0) {
    throw appErrors.create("app.not_found");
  }
};

/** A platform read as its audit event names it. */
export interface PlatformRead {
  measure: string;
  /** The App whose measure it reads: none when the read names none. */
  app?: string;
  /** The Apps it reads for in one read (`apps`), as far as they are IDs. */
  apps?: string[];
  /** Of `apps`, those it didn't count (`unavailable`). */
  unavailable?: string[];
  days?: number;
}

/** A read's input, as far as it is shaped as one. */
const platformReadSchema = z.looseObject({
  measure: z.unknown().optional(),
  days: z.unknown().optional(),
  where: z.looseObject({ app: z.unknown().optional() }).optional(),
  apps: z.array(z.unknown()).optional(),
});

/**
 * The platform read `input` asks for, as far as it says, valid or not:
 * a read of no shape at all names nothing but its refusal. Only a measure
 * the platform publishes and a valid App ID are kept, never other text of
 * the App's: any other measure is `platform.unknown`, so a refused read is
 * audited without it.
 */
export const platformReadOf = (input: unknown): PlatformRead => {
  const parsed = platformReadSchema.safeParse(input);
  const { measure, days, where, apps } = parsed.success ? parsed.data : {};
  const app = appIdSchema.safeParse(where?.app);
  const named = (apps ?? []).slice(0, statisticMaxApps).flatMap((entry) => {
    const id = appIdSchema.safeParse(entry);
    return id.success ? [id.data] : [];
  });
  return {
    measure:
      typeof measure === "string" && isPlatformMeasure(measure)
        ? measure
        : "platform.unknown",
    ...(app.success ? { app: app.data } : {}),
    ...(apps === undefined ? {} : { apps: named }),
    ...(typeof days === "number" && Number.isInteger(days) ? { days } : {}),
  };
};

/**
 * Audits a platform read by App code acting as `authority`: allowed, or
 * refused with why (`refused`, an error's code). The audit log names
 * `actor` as reading: the App, on behalf of the person, unless the caller
 * says otherwise (a workflow run, for a sealed function its step called).
 */
export const auditPlatformRead = async (
  env: Env,
  authority: Authority,
  read: PlatformRead,
  refused?: string,
  actor: AuditActor = delegateActorOf(authority)
): Promise<void> => {
  await keepAuditEvent(env, drizzle(env.DB), {
    actor,
    action: "statistics.read",
    // Every App one read asks for, by ID (at most as many as provenance
    // holds): those it counted, then the `unavailable` ones it didn't.
    ...(read.apps === undefined
      ? {}
      : {
          provenance: [
            ...read.apps.filter(
              (app) => !(read.unavailable ?? []).includes(app)
            ),
            ...(read.unavailable ?? []),
          ],
        }),
    ...(read.app === undefined
      ? {}
      : { target: { type: "app", id: read.app } }),
    detail: {
      measure: read.measure,
      ...(read.apps === undefined ? {} : { apps: read.apps.length }),
      ...(read.unavailable === undefined
        ? {}
        : { unavailable: read.unavailable.length }),
      ...(read.days === undefined ? {} : { days: read.days }),
      onBehalfOf: authority.onBehalfOf,
      ...(refused === undefined ? {} : { refused }),
    },
  });
};

/**
 * Refuses a platform read by App code acting as `authority` unless under
 * the permission `permissionId` (`{ type: "platform" }`, `statistics`),
 * for a person who may see the runs of the one App it reads (`where.app`).
 * Of many (`apps`), the Apps the person may see: the rest are unavailable,
 * and don't refuse it.
 */
const requirePlatformRead = async (
  env: Env,
  authority: Authority,
  permissionId: PermissionId | undefined,
  query: Query
): Promise<{ visible: string[]; unavailable?: string[] }> => {
  if (permissionId === undefined) {
    throw permissionErrors.create("permission.denied", {
      action: "statistics",
    });
  }
  await authorize(
    env,
    authority,
    { type: "platform" },
    "statistics",
    permissionId
  );
  if (query.apps === undefined) {
    const app = query.where.app ?? "";
    await requireRunsVisible(env, authority, app);
    return { visible: [app] };
  }
  return await runsVisible(env, authority, query.apps);
};

/**
 * A platform measure, as `query` asks, for the Apps `apps` (those of the
 * read the person may see), over exactly the last `query.days` × 24 hours
 * before `end`.
 */
const platformMeasure = async (
  env: Env,
  measure: PlatformMeasure,
  query: Query,
  apps: readonly string[],
  end: Date
): Promise<StatisticAnswer> => {
  const start = new Date(end.getTime() - query.days * dayMs);
  if (apps.length === 0) {
    return answerOf(measure, dayOf(start), dayOf(end), query.groupBy, []);
  }
  if (measure === "platform.workflow_runs") {
    const rows = await workflowRunsMeasure(env, apps, query, start, end);
    return answerOf(measure, dayOf(start), dayOf(end), query.groupBy, rows);
  }
  const { rows, computation } = await signalsMeasure(
    env,
    apps,
    query,
    start,
    end
  );
  return {
    ...answerOf(measure, dayOf(start), dayOf(end), query.groupBy, rows),
    computation,
  };
};

/** When a read's window ends: its `until`, but never after `now`. */
const endOf = (query: Query, now: Date): Date =>
  query.until === undefined
    ? now
    : new Date(Math.min(Date.parse(query.until), now.getTime()));

/**
 * Reads a platform measure (`statisticQuerySchema`) for the App whose code
 * acts as `authority`, under the permission `platform` (its ID), of the
 * Apps whose runs the person it acts for may see (see above), over exactly
 * the last `days` × 24 hours before `now`. Without the permission it is
 * `permission.denied`. Every read is audited, allowed or refused, and why,
 * naming `actor` as reading (`auditPlatformRead`).
 */
export const readPlatformStatistics = async (
  env: Env,
  authority: Authority,
  input: unknown,
  platform?: PermissionId,
  now = new Date(),
  actor: AuditActor = delegateActorOf(authority)
): Promise<StatisticAnswer> => {
  const read = platformReadOf(input);
  let query: Query;
  let measure: PlatformMeasure;
  let counted: { visible: string[]; unavailable?: string[] };
  try {
    query = statisticErrors.parse(
      "statistics.invalid",
      statisticQuerySchema,
      input
    );
    if (authority.subject.type !== "app" || !isPlatformMeasure(query.measure)) {
      throw permissionErrors.create("permission.denied");
    }
    ({ measure } = query);
    counted = await requirePlatformRead(env, authority, platform, query);
  } catch (error) {
    await auditPlatformRead(
      env,
      authority,
      read,
      isExpectedError(error) ? error.code : "internal.unexpected",
      actor
    );
    throw error;
  }
  const { visible, unavailable } = counted;
  await auditPlatformRead(
    env,
    authority,
    {
      ...read,
      days: query.days,
      ...(unavailable === undefined ? {} : { unavailable }),
    },
    undefined,
    actor
  );
  const answer = await platformMeasure(
    env,
    measure,
    query,
    visible,
    endOf(query, now)
  );
  return unavailable === undefined ? answer : { ...answer, unavailable };
};
