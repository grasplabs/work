import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import { isAdmin } from "@grasp-os/shared/roles";
import type {
  TodayLane,
  TodayRun,
  TodayWaitsOn,
  WorkflowsToday,
} from "@grasp-os/shared/workflows";
import { and, asc, count, eq, gte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Member } from "../auth/identity.ts";
import {
  teams,
  workflowDecisions,
  workflowResourceRuns,
  workflowRuns,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { answerableByNow, stillOpen } from "../decisions/decisions.ts";
import { startOfCompanyDay } from "../organization.ts";
import { listWorkflowResources } from "../workflow-resources.ts";
import { visibleApps } from "./overview.ts";

// The company's day at work (GRA-1255), for Runs › Today: every run
// started since midnight in the organization's time zone, across the
// workflows the reader may see, a lane per workflow that worked. Threat
// model:
//
// - Naming a run, or a workflow, the reader may not see. An App's runs
//   only of the Apps the Workflows page shows them (`visibleApps`); an
//   independent workflow's only where they have a role in it, and of
//   those every run only for its builders and the organization's admins,
//   a user's own otherwise, as its Runs tab lists them. Every other run
//   of the day is counted (`unseen`), never named, nor its workflow.
// - Telling whom someone else waits for, and how long. A run waiting on
//   the reader says on whom (their role, their team, or them) and since
//   when, as their inbox does (`answerableByNow`, the one rule of who
//   answers); one waiting on anyone else only says that it waits.
// - Pointing at a run the reader may not see. The run a run came from is
//   named only when it is one of the day's runs the reader sees.
// - Load. One day of runs, at most `maxRuns` of each kind, their
//   decisions read by run in one statement.

/** The most runs of each kind one day's read takes. */
const maxRuns = 1000;

const ended = (endedAt: Date | null): string | null =>
  endedAt === null ? null : endedAt.toISOString();

/** Whom stored deciders (`role:admin`, `team:<id>`, `person:<id>`) name, for `by`. */
const waitsOnOf = (
  deciders: string,
  teamNames: ReadonlyMap<string, string>
): TodayWaitsOn => {
  const colon = deciders.indexOf(":");
  const kind = deciders.slice(0, colon);
  const id = deciders.slice(colon + 1);
  if (kind === "role") {
    return { kind: "role", role: id };
  }
  if (kind === "team") {
    return { kind: "team", team: teamNames.get(id) ?? id };
  }
  // A person's decision the reader may answer names the reader.
  return { kind: "you" };
};

/** A lane, before its runs. */
type Lane =
  | Omit<Extract<TodayLane, { kind: "app" }>, "runs">
  | Omit<Extract<TodayLane, { kind: "independent" }>, "runs">;

interface DayRun {
  id: string;
  /** Its lane's key, and the lane. */
  lane: string;
  of: Lane;
  createdAt: Date;
  endedAt: Date | null;
  status: TodayRun["status"];
  from: string | null;
}

/** The runs of the day, in the lanes of `lanes`, with their decisions. */
const runsOf = async (
  env: Env,
  by: Member,
  runs: readonly DayRun[],
  now: Date
): Promise<Map<string, TodayRun>> => {
  const db = drizzle(env.DB);
  const ids = runs.map(({ id }) => id);
  const decisions =
    ids.length === 0
      ? []
      : await db
          .select({
            id: workflowDecisions.id,
            runId: sql<string>`coalesce(${workflowDecisions.runId}, ${workflowDecisions.resourceRunId})`,
            deciders: workflowDecisions.deciders,
            description: workflowDecisions.description,
            openedAt: workflowDecisions.openedAt,
            open: sql<number>`${stillOpen(workflowDecisions, now)}`,
            mine: sql<number>`${answerableByNow(db, by.userId)}`,
          })
          .from(workflowDecisions)
          .where(
            or(
              inList(workflowDecisions.runId, ids),
              inList(workflowDecisions.resourceRunId, ids)
            )
          )
          .orderBy(asc(workflowDecisions.openedAt));
  const teamIds = decisions.flatMap(({ deciders }) =>
    deciders.startsWith("team:") ? [deciders.slice("team:".length)] : []
  );
  const named =
    teamIds.length === 0
      ? []
      : await db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(inList(teams.id, [...new Set(teamIds)]));
  const teamNames = new Map(named.map(({ id, name }) => [id, name]));
  const seen = new Set(ids);
  const result = new Map<string, TodayRun>();
  for (const run of runs) {
    const own = decisions.filter(({ runId }) => runId === run.id);
    const goesOn = run.endedAt === null;
    const open = goesOn ? own.filter(({ open: isOpen }) => isOpen === 1) : [];
    const mine = open.find(({ mine: answerable }) => answerable === 1);
    result.set(run.id, {
      id: run.id,
      startedAt: run.createdAt.toISOString(),
      endedAt: ended(run.endedAt),
      status: run.status,
      went: own.length > 0 ? "people" : "alone",
      waits:
        mine === undefined
          ? null
          : {
              decision: mine.id,
              on: waitsOnOf(mine.deciders, teamNames),
              since: mine.openedAt.toISOString(),
              asks: mine.description,
            },
      waitsOnOthers: mine === undefined && open.length > 0,
      from: run.from !== null && seen.has(run.from) ? run.from : null,
    });
  }
  return result;
};

/**
 * The runs of the company's day that `by` may see, a lane per workflow
 * that worked, oldest run first, and how many others there were.
 */
export const workflowsToday = async (
  env: Env,
  by: Member,
  now = new Date()
): Promise<WorkflowsToday> => {
  const { start, timeZone } = await startOfCompanyDay(env, now.getTime());
  const since = new Date(start);
  const db = drizzle(env.DB);
  const [apps, resources] = await Promise.all([
    visibleApps(env, by),
    listWorkflowResources(env, by),
  ]);
  const appIds = apps.map(({ id }) => id);
  const [appRuns, appTotal, resourceRuns, resourceTotal] = await Promise.all([
    appIds.length === 0
      ? []
      : db
          .select({
            id: workflowRuns.id,
            appId: workflowRuns.appId,
            workflowId: workflowRuns.workflowId,
            status: workflowRuns.status,
            createdAt: workflowRuns.createdAt,
            endedAt: workflowRuns.endedAt,
            rootRunId: workflowRuns.rootRunId,
          })
          .from(workflowRuns)
          .where(
            and(
              inList(workflowRuns.appId, appIds),
              gte(workflowRuns.createdAt, since)
            )
          )
          .orderBy(asc(workflowRuns.createdAt))
          .limit(maxRuns),
    db
      .select({ count: count() })
      .from(workflowRuns)
      .where(gte(workflowRuns.createdAt, since)),
    resources.length === 0
      ? []
      : db
          .select({
            id: workflowResourceRuns.id,
            workflowId: workflowResourceRuns.workflowResourceId,
            principalId: workflowResourceRuns.principalId,
            status: workflowResourceRuns.status,
            createdAt: workflowResourceRuns.createdAt,
            endedAt: workflowResourceRuns.endedAt,
            invokerType: workflowStartReceipts.invokerType,
            invokerId: workflowStartReceipts.invokerId,
          })
          .from(workflowResourceRuns)
          .innerJoin(
            workflowStartReceipts,
            eq(workflowStartReceipts.id, workflowResourceRuns.id)
          )
          .where(
            and(
              inList(
                workflowResourceRuns.workflowResourceId,
                resources.map(({ id }) => id)
              ),
              gte(workflowResourceRuns.createdAt, since)
            )
          )
          .orderBy(asc(workflowResourceRuns.createdAt))
          .limit(maxRuns),
    db
      .select({ count: count() })
      .from(workflowResourceRuns)
      .where(gte(workflowResourceRuns.createdAt, since)),
  ]);
  // An independent workflow's runs, as its Runs tab lists them: every
  // run for its builders and admins, a user's own otherwise.
  const everyRun = new Set(
    resources
      .filter(({ role }) => role === "builder" || isAdmin(by.role))
      .map(({ id }) => id)
  );
  const seenResourceRuns = resourceRuns.filter(
    ({ workflowId, principalId }) =>
      everyRun.has(workflowId) || principalId === by.userId
  );
  const appNames = new Map<string, string>(
    apps.map(({ id, name }) => [id, name])
  );
  const resourceNames = new Map(resources.map(({ id, name }) => [id, name]));
  const day: DayRun[] = [
    ...appRuns.map((run) => ({
      id: run.id,
      lane: JSON.stringify(["app", run.appId, run.workflowId]),
      of: {
        kind: "app" as const,
        app: appIdSchema.parse(run.appId),
        appName: appNames.get(run.appId) ?? "",
        workflow: workflowIdSchema.parse(run.workflowId),
      },
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      status: run.status,
      from: run.rootRunId,
    })),
    ...seenResourceRuns.map((run) => ({
      id: run.id,
      lane: JSON.stringify(["independent", run.workflowId]),
      of: {
        kind: "independent" as const,
        id: run.workflowId,
        name: resourceNames.get(run.workflowId) ?? "",
      },
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      status: run.status,
      from: run.invokerType === "workflow" ? run.invokerId : null,
    })),
  ];
  const told = await runsOf(env, by, day, now);
  const lanes = new Map<string, TodayLane>();
  for (const run of day) {
    const shown = told.get(run.id);
    if (shown !== undefined) {
      const lane = lanes.get(run.lane) ?? { ...run.of, runs: [] };
      lane.runs.push(shown);
      lanes.set(run.lane, lane);
    }
  }
  const total = (appTotal[0]?.count ?? 0) + (resourceTotal[0]?.count ?? 0);
  return {
    from: since.toISOString(),
    now: now.toISOString(),
    timeZone,
    lanes: [...lanes.values()],
    unseen: Math.max(0, total - day.length),
  };
};
