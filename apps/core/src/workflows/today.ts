import { isAdmin } from "@grasp-os/shared/roles";
import type {
  TodayLane,
  TodayRun,
  TodayWaitsOn,
  WorkflowsToday,
} from "@grasp-os/shared/workflows";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { Member } from "../auth/identity.ts";
import {
  teams,
  workflowDecisions,
  workflowResourceRuns,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import {
  answerableByNow,
  resourceDecisionPending,
} from "../decisions/decisions.ts";
import { startOfCompanyDay } from "../organization.ts";
import { listWorkflowResources } from "../workflow-resources.ts";

// The company's day at work (GRA-1255), for Runs › Today: every run
// started since midnight in the organization's time zone, across the
// workflows the reader may see, a lane per workflow that worked. Threat
// model:
//
// - Naming a run, or a workflow, the reader may not see. A workflow's
//   runs only where they have a role in it, and of those every run only
//   for its builders and the organization's admins, a user's own
//   otherwise, as its Runs tab lists them. Every other run of the day is
//   counted (`unseen`), never named, nor its workflow.
// - Telling whom someone else waits for, and how long. A run waiting on
//   the reader says on whom (their role, their team, or them) and since
//   when, as their inbox does (`answerableByNow`, the one rule of who
//   answers); one waiting on anyone else only says that it waits.
// - Pointing at a run the reader may not see. The run a run came from is
//   named only when it is one of the day's runs the reader sees.
// - Load. One day of runs, at most `maxRuns`, their
//   decisions read by run in one statement. On a busier day the newest
//   are read, as a run waiting on the reader is a recent one; the older
//   runs the reader may see are counted apart (`cutOff`) from those they
//   may not (`unseen`), so neither number stands for the other. A run
//   waiting on the reader is read whatever its place in the day: past
//   the newest `maxRuns` it would lose its dot and its answer.

/** The most runs one day's read takes. */
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

interface DayRun {
  id: string;
  /** Its workflow, and the workflow's name: its lane. */
  workflow: string;
  name: string;
  createdAt: Date;
  endedAt: Date | null;
  status: TodayRun["status"];
  from: string | null;
}

/** Whether `by` may answer an open decision of the run now. */
const waitsOn = (db: DrizzleD1Database, by: Member, now: Date) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(workflowDecisions)
      .where(
        and(
          eq(workflowDecisions.resourceRunId, workflowResourceRuns.id),
          resourceDecisionPending(now),
          answerableByNow(db, by.userId)
        )
      )
  );

/** `rows` and `more`, each run once, in `rows`' order then `more`'s. */
const withWaits = <T extends { id: string }>(
  rows: readonly T[],
  more: readonly T[]
): T[] => {
  const ids = new Set(rows.map(({ id }) => id));
  return [...rows, ...more.filter(({ id }) => !ids.has(id))];
};

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
            runId: workflowDecisions.resourceRunId,
            deciders: workflowDecisions.deciders,
            description: workflowDecisions.description,
            openedAt: workflowDecisions.openedAt,
            open: sql<number>`${resourceDecisionPending(now)}`,
            mine: sql<number>`${answerableByNow(db, by.userId)}`,
          })
          .from(workflowDecisions)
          .where(inList(workflowDecisions.resourceRunId, ids))
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
  const resources = await listWorkflowResources(env, by);
  // A workflow's runs, as its Runs tab lists them: every run for its
  // builders and admins, a user's own otherwise.
  const everyRun = resources
    .filter(({ role }) => role === "builder" || isAdmin(by.role))
    .map(({ id }) => id);
  const ownRuns = resources
    .filter(({ role }) => role !== "builder" && !isAdmin(by.role))
    .map(({ id }) => id);
  const seenToday = and(
    or(
      inList(workflowResourceRuns.workflowResourceId, everyRun),
      and(
        inList(workflowResourceRuns.workflowResourceId, ownRuns),
        eq(workflowResourceRuns.principalId, by.userId)
      )
    ),
    gte(workflowResourceRuns.createdAt, since)
  );
  const columns = {
    id: workflowResourceRuns.id,
    workflowId: workflowResourceRuns.workflowResourceId,
    status: workflowResourceRuns.status,
    createdAt: workflowResourceRuns.createdAt,
    endedAt: workflowResourceRuns.endedAt,
    invokerType: workflowStartReceipts.invokerType,
    invokerId: workflowStartReceipts.invokerId,
  };
  const [newestRuns, waiting, seenCount, totalCount] = await Promise.all([
    resources.length === 0
      ? []
      : db
          .select(columns)
          .from(workflowResourceRuns)
          .innerJoin(
            workflowStartReceipts,
            eq(workflowStartReceipts.id, workflowResourceRuns.id)
          )
          .where(seenToday)
          .orderBy(desc(workflowResourceRuns.createdAt))
          .limit(maxRuns),
    resources.length === 0
      ? []
      : db
          .select(columns)
          .from(workflowResourceRuns)
          .innerJoin(
            workflowStartReceipts,
            eq(workflowStartReceipts.id, workflowResourceRuns.id)
          )
          .where(
            and(
              seenToday,
              isNull(workflowResourceRuns.endedAt),
              waitsOn(db, by, now)
            )
          )
          .limit(maxRuns),
    resources.length === 0
      ? []
      : db
          .select({ count: count() })
          .from(workflowResourceRuns)
          .innerJoin(
            workflowStartReceipts,
            eq(workflowStartReceipts.id, workflowResourceRuns.id)
          )
          .where(seenToday),
    db
      .select({ count: count() })
      .from(workflowResourceRuns)
      .where(gte(workflowResourceRuns.createdAt, since)),
  ]);
  const names = new Map(resources.map(({ id, name }) => [id, name]));
  const day: DayRun[] = withWaits(newestRuns, waiting)
    .map((run) => ({
      id: run.id,
      workflow: run.workflowId,
      name: names.get(run.workflowId) ?? "",
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      status: run.status,
      from: run.invokerType === "workflow" ? run.invokerId : null,
    }))
    .toSorted(
      (one, other) => one.createdAt.getTime() - other.createdAt.getTime()
    );
  const told = await runsOf(env, by, day, now);
  const lanes = new Map<string, TodayLane>();
  for (const run of day) {
    const shown = told.get(run.id);
    if (shown !== undefined) {
      const lane = lanes.get(run.workflow) ?? {
        id: run.workflow,
        name: run.name,
        runs: [],
      };
      lane.runs.push(shown);
      lanes.set(run.workflow, lane);
    }
  }
  const total = totalCount[0]?.count ?? 0;
  const seen = seenCount[0]?.count ?? 0;
  return {
    from: since.toISOString(),
    now: now.toISOString(),
    timeZone,
    lanes: [...lanes.values()],
    cutOff: Math.max(0, seen - day.length),
    unseen: Math.max(0, total - seen),
  };
};
