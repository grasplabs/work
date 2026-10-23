/**
 * Integrations Grasp's agent builds into the platform: one build per app,
 * shared by every company that asked for it (`integrationBuilds`). A
 * build moves forward through its stages, and people at Grasp stay in it
 * at three points: they confirm Build it, approve the agent's plan (or
 * send it back), and register Grasp with the app and store its keys. A
 * person merges its pull request; that the merge reached a release and
 * the companies is read from the releases, not kept here.
 *
 *   asked → researching → plan_ready → credentials → writing → in_review → merged
 *                ↑______sent back______↓
 *
 * A plan for an app each company signs in to with its own API key skips
 * `credentials`: there are no keys of Grasp's to register. Any stage
 * still going can stop at `needs_person`: the agent gave up, a limit was
 * hit, or a wait ran out (src/builds/workflow.ts).
 *
 * Every move is one conditional write naming the stage it leaves, audited
 * in the same batch (`actIfChanged`), so two people acting at once, or an
 * event that arrives twice or late, move a build once and never back.
 * Each move that a wait of the build's run is for then sends that run its
 * event; the run reads the row before it waits and at least daily while
 * it does (src/builds/workflow.ts), so an event lost on its way holds the
 * build up for a day at most.
 */
import { connectorNameSchema } from "@grasp-os/connector-kit/manifest";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { Actor, AdminDatabase } from "../db/act.ts";
import { integrationBuilds } from "../db/schema.ts";
import { instanceStatus } from "../runners.ts";
import { buildPlanSchema } from "./plan.ts";
import type { BuildPlan } from "./plan.ts";

/** Where a build is. */
export type BuildStage = (typeof integrationBuilds.stage.enumValues)[number];

/** Stages a build can't leave: merged, or waiting for a person to look. */
const ended: ReadonlySet<BuildStage> = new Set(["merged", "needs_person"]);

/** Why an action on a build was refused, as the page words it. */
export const buildErrorCodes = [
  /** Not an app a connector can be named for, or a name people can read. */
  "invalid_app",
  /** No build of that app. */
  "unknown_build",
  /** A plan sent back says nothing of what to change. */
  "note_required",
  /** The build isn't at the stage the action is for: someone acted first, or it moved on. */
  "wrong_stage",
  /** The plan isn't one a person may approve: its shape, or another app's. */
  "invalid_plan",
  /** The pull request isn't on the build's own branch, `feat/connector-<app>`. */
  "wrong_branch",
  /** The merge names another pull request than the build's. */
  "wrong_pull_request",
] as const;
export type BuildErrorCode = (typeof buildErrorCodes)[number];

/** A refused action on a build, with its code. */
export class BuildError extends Error {
  readonly code: BuildErrorCode;

  constructor(code: BuildErrorCode, message: string) {
    super(message);
    this.name = "BuildError";
    this.code = code;
  }
}

/** The only branch a build's code may be pushed to. */
export const buildBranch = (app: string): string => `feat/connector-${app}`;

/** A build as the admin keeps it, its plan parsed. */
export type Build = Omit<typeof integrationBuilds.$inferSelect, "plan"> & {
  plan: BuildPlan | null;
};

/** The build of `app`, or null when none was asked for. */
export const buildOf = async (
  db: AdminDatabase,
  app: string
): Promise<Build | null> => {
  const [row] = await db
    .select()
    .from(integrationBuilds)
    .where(eq(integrationBuilds.app, app));
  if (row === undefined) {
    return null;
  }
  const plan =
    row.plan === null ? null : buildPlanSchema.parse(JSON.parse(row.plan));
  return { ...row, plan };
};

/** The events a build's run waits for, each named for what it waits on. */
export const buildEvents = {
  /** The agent's plan of round `round` is ready for a person. */
  plan: (round: number) => `plan-${round}`,
  /** A person approved or sent back the plan of round `round`. */
  decision: (round: number) => `decision-${round}`,
  /** A person stored the app's keys. */
  credentials: "credentials",
  /** The agent opened its pull request. */
  pullRequest: "pull-request",
  /** A person merged it. */
  merged: "merged",
} as const;

/** Sends the build's run `type`, once its row has moved. */
const wake = async (env: Env, runId: string, type: string): Promise<void> => {
  const instance = await env.INTEGRATION_BUILD.get(runId);
  await instance.sendEvent({ type, payload: {} });
};

/** A move from `from` to the fields in `set`, audited as `action`. */
interface Move {
  from: BuildStage | readonly BuildStage[];
  set: SQLiteUpdateSetSource<typeof integrationBuilds> & { stage: BuildStage };
  action: string;
  detail?: Record<string, string | number | boolean>;
}

/**
 * Moves the build of `app` as `move` says, by `actor`, if it is still in
 * the stage it leaves; returns whether it moved.
 */
const moveBuild = async (
  db: AdminDatabase,
  actor: Actor,
  app: string,
  { from, set, action, detail }: Move
): Promise<boolean> => {
  const stages = typeof from === "string" ? [from] : [...from];
  return await actIfChanged(
    db,
    actor,
    db
      .update(integrationBuilds)
      .set({ ...set, updatedAt: new Date() })
      .where(
        and(
          eq(integrationBuilds.app, app),
          inArray(integrationBuilds.stage, stages)
        )
      ),
    { action, target: app, detail: { stage: set.stage, ...detail } }
  );
};

/** The build of `app`, or `unknown_build`. */
const existing = async (db: AdminDatabase, app: string): Promise<Build> => {
  const build = await buildOf(db, app);
  if (build === null) {
    throw new BuildError("unknown_build", `No build of ${app}`);
  }
  return build;
};

/** `wrong_stage` for an action on the build of `app` meant for `stage`. */
const wrongStage = (app: string, stage: string): BuildError =>
  new BuildError("wrong_stage", `The build of ${app} isn't at ${stage}`);

/** A new build's run's instance id: the app's, and a random part of its own. */
const newRunId = (app: string): string =>
  `build-${app}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** Longest name of an app people read. */
const maxName = 64;

/**
 * Starts the build of `app` as `staff` confirmed Build it: its row at
 * `asked`, audited, then its run. Returns the build's run id. One build
 * per app: asking for an app already asked for starts nothing, and
 * returns the build there is, except a run that never started (its
 * create failed after the row was written), which starts now.
 */
export const requestBuild = async (
  env: Env,
  staff: Staff,
  { app, name }: { app: string; name: string }
): Promise<string> => {
  const trimmed = name.trim();
  if (
    !connectorNameSchema.safeParse(app).success ||
    trimmed === "" ||
    trimmed.length > maxName
  ) {
    throw new BuildError("invalid_app", `Not an app to build: ${app}`);
  }
  const db = adminDatabase(env.DB);
  const runId = newRunId(app);
  const now = new Date();
  const created = await actIfChanged(
    db,
    staff,
    db
      .insert(integrationBuilds)
      .values({
        app,
        name: trimmed,
        stage: "asked",
        runId,
        requestedBy: staff.email,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(),
    { action: "build.request", target: app, detail: { run: runId } }
  );
  const build = await existing(db, app);
  if (!created) {
    const { status } = await instanceStatus(
      env.INTEGRATION_BUILD,
      build.runId,
      build.createdAt
    );
    if (build.stage !== "asked" || status !== "gone") {
      return build.runId;
    }
  }
  await env.INTEGRATION_BUILD.create({ id: build.runId, params: { app } });
  return build.runId;
};

/**
 * Records the agent's plan for the build of `app`, ready for a person:
 * `researching` to `plan_ready`, as round `planRound + 1`. A plan that
 * doesn't parse, or names another app, is refused and the build stays
 * where it is.
 */
export const recordPlan = async (
  env: Env,
  app: string,
  plan: unknown
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const build = await existing(db, app);
  const parsed = buildPlanSchema.safeParse(plan);
  if (!parsed.success || parsed.data.app !== app) {
    throw new BuildError("invalid_plan", `Not a plan for ${app}`);
  }
  if (build.stage !== "researching") {
    throw wrongStage(app, "researching");
  }
  const round = build.planRound + 1;
  const moved = await actIfChanged(
    db,
    "system",
    db
      .update(integrationBuilds)
      .set({
        stage: "plan_ready",
        plan: JSON.stringify(parsed.data),
        planRound: round,
        planNote: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationBuilds.app, app),
          eq(integrationBuilds.stage, "researching"),
          eq(integrationBuilds.planRound, build.planRound)
        )
      ),
    {
      action: "build.plan",
      target: app,
      detail: {
        stage: "plan_ready",
        round,
        actions: parsed.data.actions.length,
        hosts: parsed.data.hosts.length,
      },
    }
  );
  if (!moved) {
    throw wrongStage(app, "researching");
  }
  await wake(env, build.runId, buildEvents.plan(round));
};

/**
 * Approves the plan of the build of `app`, as `staff`: on to
 * `credentials` for Grasp's own OAuth app, whose keys a person registers
 * next, or straight to `writing` for an app each company gives its own
 * API key for. `round` is the plan the person read, so approving a plan
 * never passes for a newer one they haven't seen.
 */
export const approvePlan = async (
  env: Env,
  staff: Staff,
  app: string,
  round: number
): Promise<BuildStage> => {
  const db = adminDatabase(env.DB);
  const build = await existing(db, app);
  if (
    build.stage !== "plan_ready" ||
    build.planRound !== round ||
    build.plan === null
  ) {
    throw wrongStage(app, "plan_ready");
  }
  const next = build.plan.signIn === "oauth2" ? "credentials" : "writing";
  const moved = await actIfChanged(
    db,
    staff,
    db
      .update(integrationBuilds)
      .set({ stage: next, approvedBy: staff.email, updatedAt: new Date() })
      .where(
        and(
          eq(integrationBuilds.app, app),
          eq(integrationBuilds.stage, "plan_ready"),
          eq(integrationBuilds.planRound, round)
        )
      ),
    { action: "build.approve", target: app, detail: { stage: next, round } }
  );
  if (!moved) {
    throw wrongStage(app, "plan_ready");
  }
  await wake(env, build.runId, buildEvents.decision(round));
  return next;
};

/** Longest note a person sends a plan back with. */
const maxNote = 2000;

/**
 * Sends the plan of round `round` of the build of `app` back to the agent,
 * as `staff`, with what they ask for instead: back to `researching`,
 * where the agent writes the next round.
 */
export const sendBackPlan = async (
  env: Env,
  staff: Staff,
  app: string,
  round: number,
  note: string
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const build = await existing(db, app);
  const said = note.trim().slice(0, maxNote);
  if (said === "") {
    throw new BuildError(
      "note_required",
      "Say what the next plan should change"
    );
  }
  const moved = await actIfChanged(
    db,
    staff,
    db
      .update(integrationBuilds)
      .set({
        stage: "researching",
        planNote: said,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationBuilds.app, app),
          eq(integrationBuilds.stage, "plan_ready"),
          eq(integrationBuilds.planRound, round)
        )
      ),
    {
      action: "build.send_back",
      target: app,
      detail: { stage: "researching", round },
    }
  );
  if (!moved) {
    throw wrongStage(app, "plan_ready");
  }
  await wake(env, build.runId, buildEvents.decision(round));
};

/**
 * Records, as `staff`, that Grasp is registered with the app of the build
 * of `app` and its keys are in Secrets Store: on to `writing`. The keys
 * never pass through here.
 */
export const confirmCredentials = async (
  env: Env,
  staff: Staff,
  app: string
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const build = await existing(db, app);
  const moved = await moveBuild(db, staff, app, {
    from: "credentials",
    set: { stage: "writing" },
    action: "build.credentials",
  });
  if (!moved) {
    throw wrongStage(app, "credentials");
  }
  await wake(env, build.runId, buildEvents.credentials);
};

/**
 * Records the pull request the agent opened for the build of `app`:
 * `writing` to `in_review`. It must be on the build's own branch.
 */
export const recordPullRequest = async (
  env: Env,
  app: string,
  { number, branch }: { number: number; branch: string }
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const build = await existing(db, app);
  if (branch !== buildBranch(app)) {
    throw new BuildError(
      "wrong_branch",
      `The build of ${app} may only open a pull request from ${buildBranch(app)}`
    );
  }
  const moved = await moveBuild(db, "system", app, {
    from: "writing",
    set: { stage: "in_review", branch, pullRequest: number },
    action: "build.pull_request",
    detail: { pull_request: number },
  });
  if (!moved) {
    throw wrongStage(app, "writing");
  }
  await wake(env, build.runId, buildEvents.pullRequest);
};

/** A full commit sha, as GitHub names a merge. */
const commitShaPattern = /^[0-9a-f]{40}$/u;

/**
 * Records that the pull request of the build of `app` was merged as
 * `commitSha`: `in_review` to `merged`. Only the build's own pull request
 * counts.
 */
export const recordMerge = async (
  env: Env,
  app: string,
  { number, commitSha }: { number: number; commitSha: string }
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const build = await existing(db, app);
  if (build.pullRequest !== number || !commitShaPattern.test(commitSha)) {
    throw new BuildError(
      "wrong_pull_request",
      `#${number} isn't the build of ${app}'s pull request`
    );
  }
  const moved = await moveBuild(db, "system", app, {
    from: "in_review",
    set: { stage: "merged", mergeCommitSha: commitSha },
    action: "build.merge",
    detail: { pull_request: number, commit: commitSha },
  });
  if (!moved) {
    throw wrongStage(app, "in_review");
  }
  await wake(env, build.runId, buildEvents.merged);
};

/**
 * Starts the agent's research for the build of `app`: `asked` to
 * `researching`, by its run. Returns whether it moved: a run started
 * again finds it moved already.
 */
export const startResearching = async (
  db: AdminDatabase,
  app: string
): Promise<boolean> =>
  await moveBuild(db, "system", app, {
    from: "asked",
    set: { stage: "researching" },
    action: "build.research",
  });

/** Stages a build can come to need a person from: every stage still going. */
const going = integrationBuilds.stage.enumValues.filter(
  (stage) => !ended.has(stage)
);

/**
 * Stops the build of `app` for a person to look at, with `reason` (a
 * code), from whatever stage it is still going in; returns whether it
 * stopped. A build merged, or stopped already, stays as it is.
 */
export const stopForPerson = async (
  db: AdminDatabase,
  app: string,
  reason: string
): Promise<boolean> =>
  await moveBuild(db, "system", app, {
    from: going,
    set: {
      stage: "needs_person",
      stoppedAt: sql`${integrationBuilds.stage}`,
      reason,
    },
    action: "build.stop",
    detail: { reason },
  });
