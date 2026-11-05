import { declaredWorkflows } from "@grasp-os/sdk/host";
import { decisionErrors } from "@grasp-os/shared/decisions";
import type {
  DecisionConfirmation,
  DecisionReview,
  DecisionView,
} from "@grasp-os/shared/decisions";
import { runIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "../app-releases.ts";
import { appFor } from "../apps.ts";
import {
  appWorkflowBindings,
  workflowDecisions,
  workflowResourceRuns,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import {
  answerDecision,
  confirmDecision,
  reviewDecision,
} from "../decisions/decisions.ts";
import { appHost } from "../durable-objects.ts";

// An App's screens answering the decisions of the runs the App started of
// the independent workflows it binds (`screens` in session-rpc.ts, through
// the page's bridge to one App's screen), for the person using it: they
// need a role in the App (`appFor`, as every screen call), and a
// decision's own rules decide who answers it (decisions.ts).
//
// A screen acts for whoever has it open, without asking them each time:
// the App's code decides what a click answers. So answers from a screen
// are audited as such (`via: "screen"`), next to who they were for.

/** A decision's ID, as a screen names it. */
const decisionNameSchema = z.string().min(1).max(256);

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
 * The ID of the decision `decision` of the run `run`, as a screen names
 * it: by its ID (workflows.<alias>.queries.decisions, its wait's `id`).
 * `decision.not_found` for any other, alike.
 *
 * A run's decision is the App's to answer only while:
 * - the App started its run (its start receipt names the App);
 * - the frame's release pins the run's workflow version for an alias the
 *   App's binding still names it under, as the inbox lists it;
 * - the run's restricted mode is the App's: a restricted run's only
 *   through a restricted App (what it holds never out through one that
 *   isn't), and an unrestricted run's only through an App that isn't
 *   (an answer a restricted App's screen composes may carry what it
 *   read, as its sends may: screen-workflows.ts).
 * Who may answer, until when, against
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
  const independent =
    release === undefined
      ? undefined
      : await drizzle(env.DB)
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
 * confirm the screen's answer to the decision `decision` of the run `run` (`reviewDecision`).
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
 * decision `decision` of the run `run`,
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
 * Answers the decision `decision` of the run `run`, for the person using the screen, as the decision's page does
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
