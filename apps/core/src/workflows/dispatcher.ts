import { appIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import type { AppId, RunId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import type {
  WorkflowEvent,
  WorkflowStep,
} from "@grasp-os/workerflow/contracts";

import { callApp } from "../app.ts";
import { callsFor, versionFiles } from "../apps.ts";
import { runBindingsFor } from "../bindings.ts";
import { runBuildJob } from "../build-jobs.ts";
import { runExtraction } from "../knowledge/extraction.ts";
import type { WorkContext } from "../restricted.ts";
import { runBackfill } from "../store-backfill.ts";
import { declaredParams, loadRun } from "./code.ts";
import type { Settled, StepError } from "./code.ts";
import { runParamsSchema } from "./engine.ts";
import type { InternalWorkflow, PinnedRun, RunPin } from "./engine.ts";
import {
  countedStep,
  coreStepPrefix,
  fromIsolate,
  RunHost,
  settle,
  stepLimitOf,
} from "./host.ts";
import type {
  AiCalls,
  BusyRefusals,
  FailedStep,
  HostedRun,
  RunStep,
} from "./host.ts";
import { paramValues } from "./param-values.ts";
import { appRecord, findRun, recordFailure, recordWaiting } from "./runs.ts";
import type { RunRow, Stopped } from "./runs.ts";

// What every run executes (run-object.ts): each time the engine activates
// a run, at its start and on every wake or recovery, the dispatcher loads
// it afresh: the run's row, who it acts for now, an env built from the
// App's permissions as they are now, and the workflow's code at the run's
// own version, which the engine keeps as the run's pin (engine.ts). So a
// run keeps its code when a new version becomes current, and a permission
// revoked while it waited is gone from its next step on.
//
// Who a run acts for (threat model decision Q10): the person who started
// it, or, for a run a trigger started, the App's owner. A run acts for
// nobody who has left, checked at every load and before every step: once
// they have, the run fails, whoever started it.
//
// Core's own workflows run here too (engine.ts): a run pinned to the
// internal workflow it is, not an App version, runs that workflow's code,
// which is core's, with core's env.
//
// A run the engine has paused, terminated or taken over (a newer
// activation) is fenced by the engine: its calls of the step API never
// settle, so none of its code, core's or the App's, runs on in an
// activation that is over (@grasp-os/workerflow, activation.ts).
//
// A run's parameter values are the ones people set (params.ts), read as
// the version it is pinned to declares them, never the current version:
// so a stored value counts only where that version declares it of that
// kind. The SDK records them in the run's first step, so a run keeps the
// values it started with.

/**
 * Who a run acts for now: its person, or its App's owner; and the App
 * version whose code it runs, for the audit log.
 */
const authorityOf = async (env: Env, row: RunRow): Promise<Authority> => {
  const app = appIdSchema.parse(row.appId);
  const { ownerId } = await appRecord(env, app);
  return {
    subject: { type: "app", appId: app },
    onBehalfOf: row.startedBy ?? ownerId,
    mode: "workflow",
    appVersion: row.version,
  };
};

/**
 * What a failed run reports: the step it stopped at, when it failed with
 * the error of the step that failed last (workflow code that caught that
 * error and failed otherwise, or failed before any step, stopped at none),
 * and its error's code and message.
 */
const stoppedWith = (
  error: StepError,
  last: FailedStep | undefined
): Stopped => {
  const atStep =
    last !== undefined &&
    last.error.name === error.name &&
    last.error.message === error.message &&
    last.error.code === error.code;
  return {
    step: atStep ? last.step : null,
    input: atStep ? last.input : null,
    error: {
      code: error.code ?? "workflow.run_failed",
      message: error.message,
    },
  };
};

/** The error a failed run ends with: its own name and message. */
const runError = ({ name, message }: StepError): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

/**
 * How the run's code ended: as it reports it, or as loading it failed
 * (its person has left, say, or its code doesn't build).
 */
const settledRun = async (
  run: () => Promise<unknown>
): Promise<Settled<unknown>> => {
  const outer = await settle(run);
  return outer.ok ? fromIsolate(outer.value) : outer;
};

/** The run's App, as a context for its restricted mode. */
const contextOf = (app: AppId, runId: RunId): WorkContext => ({
  type: "run",
  appId: app,
  runId,
});

/**
 * The delay before every step's retry, in milliseconds, when tests set one
 * (`WORKFLOW_RETRY_DELAY_MS`): so a test of a step that fails for a moment
 * needn't wait out its real backoff.
 */
const testRetryDelayOf = (env: Env): number | undefined => {
  const set = Number(env.WORKFLOW_RETRY_DELAY_MS);
  return env.WORKFLOW_RETRY_DELAY_MS !== undefined &&
    Number.isInteger(set) &&
    set >= 0
    ? set
    : undefined;
};

/** The engine's `step`, as the host and core's own workflows take it. */
const runStepOf = (env: Env, step: WorkflowStep): RunStep => {
  const delay = testRetryDelayOf(env);
  return {
    do: async (name, config, fn) =>
      await step.do(
        name,
        delay === undefined || config.retries === undefined
          ? config
          : { ...config, retries: { ...config.retries, delay } },
        fn
      ),
    sleep: async (name, duration) => {
      await step.sleep(name, duration);
    },
    waitForEvent: async (name, options) =>
      await step.waitForEvent(name, options),
  };
};

/** What a run keeps beside the engine's journal, in its own object. */
export interface RunMemory {
  busyRefusals: BusyRefusals;
  /** Its AI calls in flight and answers no attempt took (host.ts). */
  aiCalls: AiCalls;
}

/** Runs (or resumes) one run of an App's workflow. */
const runWorkflow = async (
  env: Env,
  pinned: PinnedRun,
  event: Pick<WorkflowEvent, "instanceId" | "payload">,
  engineStep: RunStep,
  memory: RunMemory
): Promise<unknown> => {
  const runId = runIdSchema.parse(event.instanceId);
  const row = await findRun(env, runId);
  if (
    !row ||
    row.appId !== pinned.app ||
    row.workflowId !== pinned.workflow ||
    row.version !== pinned.version
  ) {
    throw new Error(`Run ${runId} doesn't match its record`);
  }
  // Cancelled (its tombstone written, the engine maybe not yet told) or
  // ended otherwise in core's record (its start failed): it does nothing
  // more. Every activation, its first and every later one, comes here
  // before any step, so such a run takes no step.
  if (row.cancelRequestedAt !== null) {
    throw new Error(`Run ${runId} has been cancelled`);
  }
  if (row.status === "cancelled" || row.status === "failed") {
    throw new Error(`Run ${runId} has ended: ${row.status}`);
  }
  // Its details were removed (retention.ts), the engine's record of its
  // steps with them: a run under its ID now would run every step again,
  // side effects too, with nothing to replay. Nothing creates one (a
  // start sent again finds it deleted, engine.ts); if something did, it
  // takes no step.
  if (row.detailsRemovedAt !== null) {
    throw new Error(`Run ${runId} has ended: its details were removed`);
  }
  const step = countedStep(engineStep, stepLimitOf(env));
  let lastFailed: FailedStep | undefined;
  const stepFailed = (failure: FailedStep): void => {
    lastFailed = failure;
  };
  // The refusal that caught the run's isolate tampering (host.ts), if any:
  // the run fails with it, whatever its code made of the refusal.
  let tampered: StepError | undefined;
  const result = await settledRun(async () => {
    const authority = await authorityOf(env, row);
    const { bindings, connections, apps } = await runBindingsFor(
      env,
      authority,
      contextOf(pinned.app, runId)
    );
    const files = await versionFiles(env, pinned.app, pinned.version);
    const run: HostedRun = {
      ...pinned,
      runId,
      // The engine's record of the run, never its input.
      ...(row.rootRunId === null
        ? {}
        : { rootRunId: runIdSchema.parse(row.rootRunId) }),
      authority,
      collections: bindings,
      connections,
      apps,
      calls: await callsFor(env, pinned),
    };
    // Read on every load, though only the run's first uses them: after
    // that the SDK replays the values its `$params` step recorded.
    const params = await paramValues(
      env,
      run.app,
      run.workflow,
      await declaredParams(env, run.app, run.version, run.workflow, files)
    );
    const code = loadRun(env, {
      version: run.version,
      workflow: run.workflow,
      files,
    });
    const host = new RunHost(env, step, run, {
      stepFailed,
      busyRefusals: memory.busyRefusals,
      aiCalls: memory.aiCalls,
      tampered: (error) => {
        tampered ??= error;
      },
      waiting: async (why) => {
        await recordWaiting(env, row, why);
      },
      callApp: async (caller, method, args, ends) =>
        await callApp(env, run.app, caller, method, args, ends),
    });
    return await code.run(host, {
      runId,
      params: Object.fromEntries(params),
      input: event.payload,
      collections: Object.keys(bindings),
      connections: Object.keys(connections),
      apps: Object.keys(apps),
    });
  });
  const failed = tampered ?? (result.ok ? undefined : result.error);
  if (failed) {
    // A failed run stops here, whatever failed: the step's retries (only
    // for failures trying again may fix, host.ts) are behind it. Its
    // report is kept in a step, once, before the run ends; its end, and
    // that it failed, are the engine's to say (runs.ts, `projectStatus`).
    const stopped = stoppedWith(failed, lastFailed);
    await step.do(`${coreStepPrefix}end`, {}, async () => {
      await recordFailure(env, row, stopped);
      return null;
    });
    throw runError(failed);
  }
  return result.ok ? result.value : undefined;
};

/** Each of core's own workflows, by name. */
const internalRuns: Record<
  InternalWorkflow,
  (env: Env, input: unknown, step: RunStep) => Promise<void>
> = {
  extraction: runExtraction,
  build: runBuildJob,
  backfill: runBackfill,
};

/**
 * Runs (or resumes) one activation of the run `event` names, as it is
 * pinned: an App's workflow at its version, or one of core's own.
 */
export const runPinned = async (
  env: Env,
  pin: RunPin,
  event: Pick<WorkflowEvent, "instanceId" | "payload">,
  engineStep: WorkflowStep,
  memory: RunMemory
): Promise<unknown> => {
  const step = runStepOf(env, engineStep);
  const { input } = runParamsSchema.parse(event.payload);
  if (pin.type === "internal") {
    await internalRuns[pin.workflow](env, input, step);
    return null;
  }
  const { app, workflow, version } = pin;
  return await runWorkflow(
    env,
    { app, workflow, version },
    { instanceId: event.instanceId, payload: input },
    step,
    memory
  );
};
