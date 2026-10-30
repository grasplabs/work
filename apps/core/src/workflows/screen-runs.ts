import { declaredWorkflows } from "@grasp-os/sdk/host";
import { decisionErrors } from "@grasp-os/shared/decisions";
import type {
  DecisionConfirmation,
  DecisionReview,
  DecisionView,
} from "@grasp-os/shared/decisions";
import { runIdSchema } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ScreenRun, WaitingDecision } from "@grasp-os/shared/screens";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { RunStatus, WorkflowRun } from "@grasp-os/shared/workflows";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "../app-releases.ts";
import { appFor } from "../apps.ts";
import {
  appWorkflowBindings,
  workflowDecisions,
  workflowResourceRuns,
  workflowRuns,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import {
  answerableBy,
  answerDecision,
  confirmDecision,
  reviewDecision,
} from "../decisions/decisions.ts";
import { appHost } from "../durable-objects.ts";
import { queuedRuns } from "./admission.ts";
import {
  findRun,
  goesOn,
  queuedRun,
  runFor,
  runsPerPage,
  runStatus,
  seesDetails,
  startWorkflow,
  unended,
  workflowInputSchema,
} from "./runs.ts";
import type { RunRow } from "./runs.ts";

// An App's screens and its workflows, together (`screens` in session-rpc.ts,
// through the page's bridge to one App's screen): a screen starts runs of
// its App's workflows, follows them, and answers their decisions, for the
// person using it. Within one App no permission is needed; the person needs
// a role in the App (`appFor`, as every screen call), and a decision's own
// rules decide who answers it (decisions.ts: its `from`, and never the
// run's starter unless it names exactly them).
//
// A screen acts for whoever has it open, without asking them each time:
// the App's code decides what a click starts or answers. So starts and
// answers from a screen are audited as such (`via: "screen"`), next to who
// they were for.
//
// A screen names its App's runs only: a run of another App is
// `workflow.run_not_found`, and a decision of one `decision.not_found`,
// whatever the person may do in that other App, exactly as a run or
// decision there isn't. Behind `screen_workflows`, besides `workflows`
// (and `decisions` to show or answer one).

/** A decision's name, as the workflow gives it (`step.decision(name)`). */
const decisionNameSchema = z.string().min(1).max(256);

/** A workflow's ID as a screen names it; `workflow.invalid` if it isn't one. */
export const screenWorkflow = (workflow: unknown): WorkflowId => {
  const parsed = workflowInputSchema.safeParse(workflow);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  return parsed.data;
};

/** The run `run` of `app`; `workflow.run_not_found` for any other. */
const appRun = async (env: Env, app: AppId, run: unknown): Promise<RunRow> => {
  const id = runIdSchema.safeParse(run);
  if (!id.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  const row = await findRun(env, id.data);
  if (row?.appId !== app) {
    throw workflowErrors.create("workflow.run_not_found");
  }
  return row;
};

/** An open decision, as read for a screen. */
interface OpenDecision {
  id: string;
  runId: string;
  step: string;
  deciders: string;
  description: string;
  expiresAt: Date;
}

/**
 * What a screen reads of an open decision, of an App's run: read joined
 * to its run, so its run is always an App's (`run_id`).
 */
const openColumns = {
  id: workflowDecisions.id,
  runId: sql<string>`${workflowDecisions.runId}`,
  step: workflowDecisions.step,
  deciders: workflowDecisions.deciders,
  description: workflowDecisions.description,
  expiresAt: workflowDecisions.expiresAt,
};

/** Open decisions of unended runs, before their deadline, as a condition. */
const openNow = (now: Date): SQL | undefined =>
  and(
    eq(workflowDecisions.status, "open"),
    gt(workflowDecisions.expiresAt, now),
    inArray(workflowRuns.status, unended)
  );

/**
 * The decisions each of `runs` waits for, as `by` sees them. A decision's
 * description is written by workflow code, and can hold what the run read
 * for its person, so it goes only to whoever sees the run's details
 * (`seesDetails`) or may answer the decision; everyone else gets its name
 * and deadline.
 */
const waitingFor = async (
  env: Env,
  by: Identity,
  owner: string,
  runs: readonly RunRow[],
  open: readonly OpenDecision[]
): Promise<Map<string, WaitingDecision[]>> => {
  const detailed = new Set(
    runs.filter((row) => seesDetails(by, row, owner)).map(({ id }) => id)
  );
  const answerable = await answerableBy(
    env,
    by,
    open.filter(({ runId }) => !detailed.has(runId))
  );
  const waiting = new Map<string, WaitingDecision[]>();
  for (const decision of open) {
    const shown = detailed.has(decision.runId) || answerable.has(decision.id);
    waiting.set(decision.runId, [
      ...(waiting.get(decision.runId) ?? []),
      {
        name: decision.step,
        expiresAt: decision.expiresAt.toISOString(),
        ...(shown ? { description: decision.description } : {}),
      },
    ]);
  }
  return waiting;
};

/** The statuses of a run that has ended. */
const endedStatuses: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * A run as a screen sees it, the same whichever call read it: `waiting`
 * exactly while a decision of it is open, otherwise `queued` while a step
 * waits for a share of the attempts running at once (runs.ts,
 * `queuedRun`), and `running` while it waits on anything else (a sleep, a
 * held side effect), whatever the engine calls that. An ended run waits
 * for nothing. A paused one stays paused.
 */
export const toScreenRun = (
  run: WorkflowRun,
  decisions: WaitingDecision[]
): ScreenRun => {
  if (endedStatuses.has(run.status)) {
    return { ...run, waitingFor: [] };
  }
  if (run.status === "queued") {
    if (decisions.length === 0) {
      return { ...run, waitingFor: [] };
    }
    // A decision someone may answer comes first, as in the Runs list.
    const { queued: _queued, ...going } = run;
    return { ...going, status: "waiting", waitingFor: decisions };
  }
  if (run.status === "running" || run.status === "waiting") {
    return {
      ...run,
      status: decisions.length > 0 ? "waiting" : "running",
      waitingFor: decisions,
    };
  }
  return { ...run, waitingFor: decisions };
};

/** Starts a run of the App's workflow for the person using its screen. */
export const startScreenRun = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  input: unknown
): Promise<WorkflowRun> =>
  await startWorkflow(env, by, app, workflow, input, "screen");

/**
 * The App's latest runs of `workflow`, newest first: at most
 * `runsPerPage`, with no way to page further. Each comes with the
 * decisions it waits for now; the runs and their decisions are read in
 * one batch, so they agree with each other.
 */
export const screenRuns = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown
): Promise<ScreenRun[]> => {
  const { id, owner } = await appFor(env, by, app, "user");
  const db = drizzle(env.DB);
  const ofWorkflow = and(
    eq(workflowRuns.appId, id),
    eq(workflowRuns.workflowId, screenWorkflow(workflow))
  );
  const latest = db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(ofWorkflow)
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(runsPerPage);
  const [rows, open] = await db.batch([
    db
      .select()
      .from(workflowRuns)
      .where(ofWorkflow)
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .limit(runsPerPage),
    db
      .select(openColumns)
      .from(workflowDecisions)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
      .where(and(inArray(workflowDecisions.runId, latest), openNow(new Date())))
      .orderBy(workflowDecisions.openedAt, workflowDecisions.id),
  ]);
  const [waiting, queues] = await Promise.all([
    waitingFor(env, by, owner, rows, open),
    queuedRuns(
      db,
      rows.flatMap((row) => (goesOn(row.status) ? [row.id] : [])),
      Date.now()
    ),
  ]);
  return rows.map((row) =>
    toScreenRun(
      queuedRun(runFor(env, by, row, owner), queues.get(row.id)),
      waiting.get(row.id) ?? []
    )
  );
};

/**
 * One of the App's runs as it is now (`runStatus`), with what it waits for.
 * The run and its decisions are two reads (the engine has the one, D1 the
 * other): a change between them shows until the run is read again.
 */
export const screenRun = async (
  env: Env,
  by: Identity,
  app: unknown,
  run: unknown
): Promise<ScreenRun> => {
  const { id, owner } = await appFor(env, by, app, "user");
  const row = await appRun(env, id, run);
  const found = await runStatus(env, by, row.id);
  const open = await drizzle(env.DB)
    .select(openColumns)
    .from(workflowDecisions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
    .where(and(eq(workflowDecisions.runId, row.id), openNow(new Date())))
    .orderBy(workflowDecisions.openedAt, workflowDecisions.id);
  const waiting = await waitingFor(env, by, owner, [row], open);
  return toScreenRun(found, waiting.get(row.id) ?? []);
};

/** The App a screen asks through, and the version of it the frame runs. */
export interface ScreenOf {
  readonly app: unknown;
  /** The release version of the frame's build; none for a frame with none. */
  readonly version: number | undefined;
}

/**
 * Whether App `app` may answer, through its release at `version`, a
 * decision of a run of workflow `workflowId` at `version`: as the
 * reference's inbox lists it (workflow-reference-queries.ts), the version
 * the release's seal pins for one of its aliases, while the App's binding
 * of that alias still names it.
 */
const answersThrough = async (
  env: Env,
  app: AppId,
  release: number,
  run: { workflowId: string; version: number }
): Promise<boolean> => {
  const sealed = await loadRelease(env, app, release);
  const aliases = declaredWorkflows(sealed.app, sealed.workflows)
    .filter(
      ({ pinned }) =>
        pinned?.workflowId === run.workflowId && pinned.version === run.version
    )
    .map(({ alias }) => alias);
  if (aliases.length === 0) {
    return false;
  }
  const bound = await drizzle(env.DB)
    .select({ alias: appWorkflowBindings.alias })
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, app),
        eq(appWorkflowBindings.status, "active"),
        eq(appWorkflowBindings.workflowResourceId, run.workflowId),
        eq(appWorkflowBindings.workflowResourceVersion, run.version),
        inArray(appWorkflowBindings.alias, aliases)
      )
    )
    .get();
  return bound !== undefined;
};

/**
 * The ID of the decision `decision` of the App's run `run`, as a screen
 * names it: an App run's decision by its name in the workflow; an
 * independent run's (workflows.<alias>.queries.decisions, its wait's
 * `id`) by its ID. `decision.not_found` for any other, alike.
 *
 * An independent run's decision is the App's to answer only while:
 * - the App started its run (its start receipt names the App);
 * - the frame's release pins the run's workflow version for an alias the
 *   App's binding still names it under, as the inbox lists it;
 * - the run's restricted mode is the App's: a restricted run's only
 *   through a restricted App (what it holds never out through one that
 *   isn't), and an unrestricted run's only through an App that isn't
 *   (an answer a restricted App's screen composes may carry what it
 *   read, as its sends may: screen-workflows.ts).
 * An App run keeps its App's restricted mode (restricted.ts): its
 * decisions need no such check. Who may answer, until when, against
 * which context and with which confirmation is the decision service's
 * (`answerDecision`), as on the decision's own page.
 */
const appDecision = async (
  env: Env,
  app: AppId,
  release: number | undefined,
  run: unknown,
  decision: unknown
): Promise<string> => {
  const runId = runIdSchema.safeParse(run);
  if (!runId.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  const name = decisionErrors.parse(
    "decision.invalid",
    decisionNameSchema,
    decision
  );
  const db = drizzle(env.DB);
  const found = await db
    .select({ id: workflowDecisions.id })
    .from(workflowDecisions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
    .where(
      and(
        eq(workflowDecisions.runId, runId.data),
        eq(workflowDecisions.step, name),
        eq(workflowRuns.appId, app)
      )
    )
    .get();
  if (found) {
    return found.id;
  }
  const independent =
    release === undefined
      ? undefined
      : await db
          .select({
            id: workflowDecisions.id,
            restricted: workflowResourceRuns.restricted,
            workflowId: workflowResourceRuns.workflowResourceId,
            version: workflowResourceRuns.version,
          })
          .from(workflowDecisions)
          .innerJoin(
            workflowResourceRuns,
            eq(workflowResourceRuns.id, workflowDecisions.resourceRunId)
          )
          .innerJoin(
            workflowStartReceipts,
            eq(workflowStartReceipts.id, workflowResourceRuns.id)
          )
          .where(
            and(
              eq(workflowDecisions.id, name),
              eq(workflowResourceRuns.id, runId.data),
              eq(workflowStartReceipts.invokerType, "app"),
              eq(workflowStartReceipts.invokerId, app)
            )
          )
          .get();
  if (
    release === undefined ||
    independent === undefined ||
    independent.restricted !== (await appHost(env, app).isRestricted()) ||
    !(await answersThrough(env, app, release, independent))
  ) {
    throw decisionErrors.create("decision.not_found");
  }
  return independent.id;
};

/**
 * What the page's trusted decision UI shows the person before they
 * confirm the screen's answer to the decision `decision` (its name in
 * the workflow) of the App's run `run` (`reviewDecision`).
 */
export const reviewScreenDecision = async (
  env: Env,
  by: Identity,
  screen: ScreenOf,
  run: unknown,
  decision: unknown,
  answer: unknown
): Promise<DecisionReview> => {
  const { id } = await appFor(env, by, screen.app, "user");
  return await reviewDecision(
    env,
    by,
    await appDecision(env, id, screen.version, run, decision),
    answer
  );
};

/**
 * Mints the person's one-use confirmation of the screen's answer to the
 * decision `decision` (its name in the workflow) of the App's run `run`,
 * once they confirmed it in the page's own dialog (`confirmDecision`),
 * audited as confirmed for a screen. The page calls it; the screen's
 * bridge never reaches it, and the screen never holds the confirmation.
 */
export const confirmScreenDecision = async (
  env: Env,
  by: Identity,
  screen: ScreenOf,
  run: unknown,
  decision: unknown,
  revision: unknown,
  answer: unknown
): Promise<DecisionConfirmation> => {
  const { id } = await appFor(env, by, screen.app, "user");
  return await confirmDecision(
    env,
    by,
    await appDecision(env, id, screen.version, run, decision),
    revision,
    answer,
    { app: id }
  );
};

/**
 * Answers the decision `decision` (its name in the workflow) of the App's
 * run `run`, for the person using the screen, as the decision's page does
 * (`answerDecision`): only someone it is from, never the run's starter
 * unless it names exactly them, once, before its deadline, and only with
 * the one-use confirmation the page minted once the person confirmed
 * exactly this answer in its own dialog. The screen asks the page to
 * answer, and never holds the confirmation. Audited as answered on a
 * screen.
 */
export const decideScreenRun = async (
  env: Env,
  by: Identity,
  screen: ScreenOf,
  run: unknown,
  decision: unknown,
  answer: unknown,
  confirmation: unknown
): Promise<DecisionView> => {
  const { id } = await appFor(env, by, screen.app, "user");
  return await answerDecision(
    env,
    by,
    await appDecision(env, id, screen.version, run, decision),
    answer,
    confirmation,
    { app: id }
  );
};
