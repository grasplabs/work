/**
 * A build of an integration, as a Cloudflare Workflow: one instance per
 * build, started when a person confirms Build it (src/builds/builds.ts).
 * It follows the build through its stages and waits wherever the build
 * waits: for the agent's plan, a person's decision on it, the app's keys,
 * the agent's pull request and a person's merge. People and the agent
 * move the build's row; the run is woken by the event each move sends,
 * and reads the row again first, so a move it slept through is never
 * missed and an event for an older plan never passes for a newer one.
 *
 * Each wait reads the row again at least once a day (`leave`), and the
 * steps of all of them stay well under Workflows' 1,024 per instance:
 * at most `maxPlanRounds` plans, and a day's two steps for each day a
 * build waits. A wait that runs out stops the build for a person (`needs_person`),
 * and so does any failure of the run itself. The agent's sessions start
 * from here once they exist: research where the build starts
 * researching, writing where it starts writing.
 */
import { log } from "@grasp-os/shared/log";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import {
  guarded,
  isEngineAbort,
  quickStep,
  stop,
  stopReason,
} from "../workflow-steps.ts";
import {
  buildEvents,
  buildOf,
  startResearching,
  stopForPerson,
} from "./builds.ts";
import type { BuildStage } from "./builds.ts";

/** What a build's run is started with. */
export interface BuildParams {
  /** The app's connector name: the build's. */
  app: string;
}

/** How many days the agent may take over a stage before a person looks. */
const agentDays = 1;

/** How many days a build waits for a person before it stops. */
const personDays = 30;

/**
 * Most plans one build may go through: each sent-back plan is another
 * round, and a build still without an approved plan after these needs a
 * person to rethink it, not another round.
 */
export const maxPlanRounds = 5;

/** The stage the build of `app` is in: `needs_person` once it's gone. */
const stageOf = async (
  db: ConsoleDatabase,
  app: string
): Promise<BuildStage> => {
  const build = await buildOf(db, app);
  return build?.stage ?? "needs_person";
};

/** One wait of the run: the stage it waits to leave, and the event that says it did. */
interface Wait {
  /** The step names' stem, such as `plan 2`. */
  label: string;
  from: BuildStage;
  event: string;
  /** How many days it waits, reading the row again after each. */
  days: number;
}

/**
 * Waits for the build of `app` to leave `wait.from`: the row read first,
 * then the event its move sends, then the row again. A day without the
 * event, the row is read again all the same, so an event lost on its way
 * holds the build up for a day at most. Returns the stage it moved to, or
 * `timed_out` once `wait.days` have passed.
 */
const leave = async (
  step: WorkflowStep,
  db: ConsoleDatabase,
  app: string,
  { label, from, event, days }: Wait
): Promise<BuildStage | "timed_out"> => {
  for (let day = 0; day < days; day += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one day after another
    const stage = await step.do(
      `${label} check`,
      quickStep,
      guarded(async () => await stageOf(db, app))
    );
    if (stage !== from) {
      return stage;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one day after another
      await step.waitForEvent(label, { type: event, timeout: "1 day" });
    } catch (error) {
      if (isEngineAbort(error)) {
        throw error;
      }
    }
  }
  const stage = await step.do(
    `${label} check`,
    quickStep,
    guarded(async () => await stageOf(db, app))
  );
  return stage === from ? "timed_out" : stage;
};

/**
 * From an approved plan to the merge: the keys (for Grasp's own OAuth
 * app), the agent's pull request, a person's merge.
 */
const writeAndMerge = async (
  waited: (wait: Wait) => Promise<BuildStage | `${BuildStage}_timed_out`>,
  approved: BuildStage | `${BuildStage}_timed_out`
): Promise<BuildStage | `${BuildStage}_timed_out`> => {
  let stage = approved;
  if (stage === "credentials") {
    stage = await waited({
      label: "credentials",
      from: "credentials",
      event: buildEvents.credentials,
      days: personDays,
    });
  }
  if (stage === "writing") {
    stage = await waited({
      label: "pull request",
      from: "writing",
      event: buildEvents.pullRequest,
      days: agentDays,
    });
  }
  if (stage === "in_review") {
    stage = await waited({
      label: "merge",
      from: "in_review",
      event: buildEvents.merged,
      days: personDays,
    });
  }
  return stage;
};

/**
 * Follows the build of `app` from its first plan to its merge; returns
 * where it ended, or why it needs a person.
 */
const follow = async (
  step: WorkflowStep,
  db: ConsoleDatabase,
  app: string
): Promise<BuildStage | `${BuildStage}_timed_out`> => {
  const waited = async (wait: Wait) => {
    const stage = await leave(step, db, app, wait);
    return stage === "timed_out" ? (`${wait.from}_timed_out` as const) : stage;
  };
  for (let round = 1; round <= maxPlanRounds; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one plan at a time
    const planned = await waited({
      label: `plan ${round}`,
      from: "researching",
      event: buildEvents.plan(round),
      days: agentDays,
    });
    if (planned !== "plan_ready") {
      return planned;
    }
    // oxlint-disable-next-line no-await-in-loop -- one plan at a time
    const decided = await waited({
      label: `decision ${round}`,
      from: "plan_ready",
      event: buildEvents.decision(round),
      days: personDays,
    });
    if (decided !== "researching") {
      // oxlint-disable-next-line no-await-in-loop -- the last round
      return await writeAndMerge(waited, decided);
    }
  }
  throw stop("too_many_plans", `No plan approved in ${maxPlanRounds} rounds`);
};

/**
 * The run: research started, then the build followed to its merge. One
 * that ends anywhere else stops the build for a person, with why.
 */
export class IntegrationBuild extends WorkflowEntrypoint<Env, BuildParams> {
  override async run(
    event: WorkflowEvent<BuildParams>,
    step: WorkflowStep
  ): Promise<string> {
    const { app } = event.payload;
    const db = consoleDatabase(this.env.DB);
    let ended: string;
    try {
      await step.do(
        "researching",
        quickStep,
        guarded(async () => await startResearching(db, app))
      );
      ended = await follow(step, db, app);
    } catch (error) {
      if (isEngineAbort(error)) {
        throw error;
      }
      const reason = stopReason(error);
      await step.do("stop after failing", quickStep, async () => {
        log.warn("build.stopped", { app, error: reason });
        await stopForPerson(db, app, reason.split(":", 1)[0] ?? reason);
      });
      throw error;
    }
    if (ended !== "merged" && ended !== "needs_person") {
      await step.do(
        "stop",
        quickStep,
        guarded(async () => await stopForPerson(db, app, ended))
      );
    }
    return ended;
  }
}
