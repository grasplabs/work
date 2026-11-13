import { functionErrors } from "@grasp-os/shared/functions";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { keepsState } from "@grasp-os/workflow-schema/sealed";
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Release } from "../app-releases.ts";
import { appTestRuns } from "../db/core/schema.ts";
import {
  failureOf,
  resultAsDeclared,
  pinOf,
  startCallIn,
} from "../page-workflows.ts";
import { loadWorkflowBuild } from "../workflow-builds.ts";
import { fixtureParams } from "../workflow-params.ts";
import { liveWorkflow, versionContract } from "../workflow-resources.ts";
import { acceptedInput, pinned } from "../workflow-starts.ts";
import { runEngine } from "./engine.ts";
import type { PinnedResourceRun } from "./engine.ts";
import type { RunStep } from "./host.ts";
import { quotaLimits } from "./quotas.ts";
import { runActivation } from "./resource-runs.ts";
import type { HostedActivation, ResourceRunMemory } from "./resource-runs.ts";

// Runs an App's tests start (spec 28.2, `appTest`): a test identity
// starts a workflow the release under test binds, and the run is real:
// the same sealed version and build, on the same engine, in the same run
// object and isolate, against the same host as any run of it. Only what
// is around it is the test's: it is no run of the organization's.
// Threat model, and how each is closed:
//
// - Test code starts a run of the organization's: a test's start is only
//   ever this module's, asked by the test's session in core (app-tests.ts),
//   never by anything the test's isolate holds; it writes no receipt and
//   no run row (`workflow_start_receipts`, `workflow_resource_runs`, which
//   the database keeps for good), only its own record (`app_test_runs`),
//   and the engine runs it under a pin of its own (`fixture`), which no
//   reader of runs, notification or control of the organization's knows.
// - It starts what the release doesn't bind: the reference is resolved
//   against the release under test exactly as a page's against the
//   current release (`startCallIn`), to the workflow version its seal pinned,
//   and nothing else; input is checked against the declaration and the
//   version's contract, as a start's.
// - It reaches what a test may not: the run acts for the fixture's
//   principal, no member of anything, and its host refuses every call that
//   leaves its own sealed modules (sealed-run.ts, `fixtureCalls`):
//   connections, Knowledge, files, actions and events. It holds no binding, approval or
//   grant, and none is read or written. Its decisions ask its fixture's
//   principals alone (fixture-decisions.ts; on the run host too,
//   `openFixtureDecision`); its model calls are answered by its fixture,
//   and its store calls run on its test's own fixture store, never a real
//   model or store (fixture-calls.ts).
// - It takes the organization's quotas or shares: nothing of it is
//   admitted against a lineage or the slots (`unadmitted`); its
//   isolate takes a share of the sandbox of the App's test runs' own
//   (`testRunOwnerOf`); its steps are bounded by the step limit and its
//   time by its test, which removes it.
// - It outlives its test: it is recorded before the engine is asked for
//   it, and its test's session removes it from the engine, then the
//   record, as it closes (`discardFixtureRuns`); a record left behind (a
//   run that died between the two) the quarter-hour sweep removes
//   (`sweepFixtureRuns`). The engine keeps an ended one a day at most.
//   An activation finds its record first, so a run whose test has ended
//   runs nothing more.
// - A test asks about a run it didn't start: the session keeps its runs by
//   number, and answers only those (app-tests.ts).
// - It runs with, or tells the test, what the organization set: its
//   parameters are its fixture's, or each one's declared default, never the
//   values the organization saved (`fixtureParams`); a failure reaches the
//   test only as a code the platform defines, in its own words
//   (`failureOf`), and a result only as the App's declaration projects it
//   (`resultAsDeclared`), as a page is shown them.
// - It runs past its test: its record holds the test's deadline, past which
//   no activation runs it, and from which the sweep removes it.

/**
 * Whose share of the sandbox the runs an App's tests start take: their
 * own, neither the App's runs' nor its suites' (app-tests.ts,
 * `appTestOwnerOf`): a suite waits on its run, which mustn't wait for the
 * very place the suite holds.
 */
export const testRunOwnerOf = (app: string): string => `test-runs:${app}`;

/**
 * Removes test runs `ids` from the engine, ended or not, then their
 * records: a run the engine couldn't remove keeps its record, for the
 * sweep. Never throws.
 */
export const discardFixtureRuns = async (
  env: Env,
  ids: readonly string[]
): Promise<void> => {
  const engine = runEngine(env);
  const removed: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        await engine.terminate(id);
        await engine.remove(id);
        removed.push(id);
      } catch (error) {
        log.warn("app_tests.run_discard_failed", {
          runId: id,
          ...errorFields(error),
        });
      }
    })
  );
  if (removed.length > 0) {
    try {
      await drizzle(env.DB)
        .delete(appTestRuns)
        .where(inArray(appTestRuns.runId, removed));
    } catch (error) {
      // The engine let go of them: their records stay, for the sweep.
      log.warn("app_tests.run_record_delete_failed", {
        runs: removed.length,
        ...errorFields(error),
      });
    }
  }
};

/** What a test gives its run's start beside the request (`TestStartOptions`). */
export interface FixtureStart {
  /** Its parameter values: any other takes its declared default. */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Who may answer each of its decisions, by the decision binding's
   * alias: the test's identities' names (fixture-decisions.ts).
   */
  readonly deciders: Readonly<Record<string, readonly string[]>>;
  /**
   * What each of its model bindings answers, by the binding's alias
   * (fixture-calls.ts).
   */
  readonly models: Readonly<Record<string, unknown>>;
  /** The task after whose step's first outcome its activation restarts. */
  readonly restartAfterStep?: string;
  /** How far the test moved its clock on before it started, in ms. */
  readonly clockMs: number;
  /** When its test's time is up (ms since the epoch). */
  readonly deadline: number;
  /** Told once its record is written: from then on, it is a run to remove. */
  readonly recorded: () => void;
}

/** A test's run as its start answers it. */
export interface FixtureRunStarted {
  readonly runId: string;
  /** What the App declares the workflow returns (`resultAsDeclared`). */
  readonly returns: unknown;
}

/**
 * Starts the run of the workflow `request` (a call of its reference's
 * `start` mutation, as a page's) names, as `principal` of the test of
 * `release`: its run's ID. Refused as a page's start would be, for
 * anything the release doesn't bind. A start that fails once its run is
 * recorded removes the run again.
 */
export const startFixtureRun = async (
  env: Env,
  release: Release,
  principal: string,
  request: unknown,
  test: FixtureStart
): Promise<FixtureRunStarted> => {
  const { resolved, args: declared } = await startCallIn(release, request);
  const pin = pinOf(resolved);
  const workflow = workflowResourceIdSchema.parse(pin.workflowId);
  // The workflow's live version, as a page's start runs.
  const live = await liveWorkflow(env, workflow);
  const version = live?.currentVersion;
  if (version === undefined || version === null) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  const found = await pinned(env, workflow, version);
  const input = acceptedInput(found.inputDescriptor, declared);
  const params = await fixtureParams(env, workflow, version, test.params);
  // A fault after a task the version doesn't have, or that no test run
  // gets past (only its model calls are answered: fixture-calls.ts), or
  // whose step journals no result (a sleep's, a wait's), would never fire,
  // and its test would pass on a run that never restarted.
  if (test.restartAfterStep !== undefined) {
    const build = await loadWorkflowBuild(
      env,
      workflow,
      version,
      found.manifestHash
    );
    if (
      !build.tasks.some(
        (task) =>
          task.id === test.restartAfterStep &&
          keepsState(task) &&
          task.kind === "call" &&
          task.call.name === "grasp.model"
      )
    ) {
      throw functionErrors.create("contract.invalid_args");
    }
  }
  const runId = crypto.randomUUID();
  // Recorded before the engine hears of it, so nothing runs unrecorded.
  await drizzle(env.DB)
    .insert(appTestRuns)
    .values({
      runId,
      appId: release.manifest.resourceId,
      appVersion: release.manifest.resourceVersion,
      workflowResourceId: workflow,
      version,
      manifestHash: found.manifestHash,
      buildHash: found.buildHash,
      principal,
      input,
      params,
      deciders: JSON.stringify(test.deciders),
      models: JSON.stringify(test.models),
      restartAfterStep: test.restartAfterStep ?? null,
      // At the time its test's clock is at: its age is its runs' time.
      createdAt: new Date(Date.now() + test.clockMs),
      deadline: new Date(test.deadline),
    });
  test.recorded();
  try {
    await runEngine(env).createFixture({
      id: runId,
      pinned: { workflow, version, manifest: found.manifestHash },
      input: z.json().parse(JSON.parse(input)),
      clockMs: test.clockMs,
    });
  } catch (error) {
    // The engine may have it, or not: removed either way, its record with
    // it, or left for the sweep.
    await discardFixtureRuns(env, [runId]);
    throw error;
  }
  return { runId, returns: resolved.declared.returns };
};

const jsonObjectSchema = z.record(z.string(), z.json());

/**
 * What an activation of the test's run `runId` runs, as `pin` names it:
 * its record, checked against the pin and the sealed build, with a
 * calling context that reaches nothing outside it. A run whose record is
 * gone (its test ended) runs nothing.
 */
export const fixtureActivation = async (
  env: Env,
  pin: PinnedResourceRun,
  runId: string
): Promise<HostedActivation & { fault: string | null }> => {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(appTestRuns)
    .where(eq(appTestRuns.runId, runId))
    .get();
  if (
    row === undefined ||
    row.workflowResourceId !== pin.workflow ||
    row.version !== pin.version ||
    row.manifestHash !== pin.manifest
  ) {
    throw new Error(`Test run ${runId} doesn't match its record`);
  }
  // Its test is over: nothing more of it runs.
  if (Date.now() > row.deadline.getTime()) {
    throw functionErrors.create("function.cancelled");
  }
  const build = await loadWorkflowBuild(
    env,
    pin.workflow,
    pin.version,
    pin.manifest
  );
  if (build.hash !== row.buildHash) {
    throw workflowResourceErrors.create("workflow.version_corrupt");
  }
  const contract = await versionContract(env, pin.workflow, pin.version);
  if (contract === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const limits = quotaLimits(env);
  return {
    run: {
      runId,
      workflowId: pin.workflow,
      version: pin.version,
      principal: row.principal,
      input: z.json().parse(JSON.parse(row.input)),
      params: jsonObjectSchema.parse(JSON.parse(row.params)),
      // An App's test reads nothing of the organization's: none of what
      // the workflow keeps between its runs either.
      state: {},
      createdAt: row.createdAt.getTime(),
      build,
      // Its calls go nowhere real (sealed-run.ts, `fixtureCalls`;
      // fixture-calls.ts): it binds nothing, acts for the fixture's
      // principal alone, and `makeCall` refuses every call of it.
      calling: {
        runId,
        // Its own lineage's root: a test's run starts no other run.
        rootRunId: runId,
        accountRunId: runId,
        workflowId: pin.workflow,
        version: pin.version,
        principal: row.principal,
        invoker: { type: "app", id: row.appId, appVersion: row.appVersion },
        bindings: new Map(),
        restricted: false,
        fixture: true,
      },
      // As many model calls as a run of the version may make: each is
      // answered by its fixture, never a model's.
      maxModelCalls: limits.lineageModelRequests,
    },
    output: JSON.stringify(contract.returns),
    owner: testRunOwnerOf(row.appId),
    admission: "fixture",
    // The fault its test gave it, unless it fired already.
    fault: row.restartedAt === null ? row.restartAfterStep : null,
  };
};

/**
 * Whether the fault test run `runId` was given fires now, after task
 * `task`'s step: once, for the task it names, the first time its step
 * has an outcome. Taken in one conditional write, so a replay, or two
 * activations at once, never fire it twice.
 */
const faultFires = async (
  env: Env,
  runId: string,
  task: string
): Promise<boolean> => {
  const taken = await drizzle(env.DB)
    .update(appTestRuns)
    .set({ restartedAt: new Date() })
    .where(
      and(
        eq(appTestRuns.runId, runId),
        eq(appTestRuns.restartAfterStep, task),
        isNull(appTestRuns.restartedAt)
      )
    )
    .returning({ runId: appTestRuns.runId });
  return taken.length > 0;
};

/** The suffix of a task's step, as the run host names it (`<id>:task`). */
const taskStepSuffix = ":task";

/**
 * What never settles: the activation it is in is over, fenced, and the
 * run goes on in the one that took it over.
 */
const never = async (): Promise<never> =>
  await Promise.withResolvers<never>().promise;

/**
 * `engineStep`, with the fault test run `runId` was given
 * (`restartAfterStep`): once its task's step has an outcome, journaled
 * by the engine, its activation is ended as a dying process would end it
 * and a new one replays the run from its journal (`restart`). The step
 * isn't run again: its outcome is the journal's.
 */
const withFault = (
  env: Env,
  runId: string,
  engineStep: RunStep,
  fault: string | null,
  restart: (() => Promise<void>) | undefined
): RunStep => ({
  ...engineStep,
  do: async (name, config, fn) => {
    const value = await engineStep.do(name, config, fn);
    if (
      restart !== undefined &&
      fault !== null &&
      name === `${fault}${taskStepSuffix}` &&
      (await faultFires(env, runId, fault))
    ) {
      await restart();
      return await never();
    }
    return value;
  },
});

/**
 * Runs one activation of the test's run `runId` (`fixtureActivation`)
 * against a host that reaches nothing outside it (resource-runs.ts,
 * `runActivation`), with the fault its test gave it.
 */
export const runFixtureWorkflow = async (
  env: Env,
  pin: PinnedResourceRun,
  runId: string,
  engineStep: RunStep,
  memory: ResourceRunMemory
): Promise<unknown> => {
  const activation = await fixtureActivation(env, pin, runId);
  return await runActivation(
    env,
    withFault(env, runId, engineStep, activation.fault, memory.restart),
    memory,
    activation
  );
};

/**
 * Moves the clock of test runs `ids` `ms` on (workerflow's
 * `advanceClock`): what each waits for that comes due by then runs now.
 * A run the engine no longer has is passed over.
 */
export const advanceFixtureClocks = async (
  env: Env,
  ids: readonly string[],
  ms: number
): Promise<void> => {
  const engine = runEngine(env);
  await Promise.all(
    ids.map(async (id) => {
      // A run the engine no longer has (removed past its retention) has
      // no time to move.
      if ((await engine.status(id)) !== undefined) {
        await engine.advanceFixtureClock(id, ms);
      }
    })
  );
};

/**
 * How a test's run ended, as `t.runs.untilTerminal` answers it: a failure
 * as a page is told one (`failureOf`), a result as the App declares it
 * (`resultAsDeclared`).
 */
export type FixtureRunOutcome =
  | { readonly status: "completed"; readonly result: Json }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
    }
  | { readonly status: "cancelled" };

/** How often a test asks the engine whether its run ended, in ms. */
const pollMs = 100;

/** `error`'s code, for `failureOf`, if it is an error of the platform's. */
const codeOf = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : null;

/**
 * A failure as the test is told it (`failureOf`): the platform's code and
 * words, or a raise's code and its sealed words.
 */
const failed = (code: string | null, message?: string): FixtureRunOutcome => {
  const told = failureOf({
    code,
    ...(message === undefined ? {} : { message }),
  });
  return { status: "failed", code: told.code, message: told.message };
};

/**
 * How test run `run` ended, asking the engine until it has, `until` (ms
 * since the epoch) passes, or `stopped` says its test is over: undefined
 * when it hadn't by then.
 */
export const fixtureRunOutcome = async (
  env: Env,
  run: FixtureRunStarted,
  { until, stopped }: { until: number; stopped: () => boolean }
): Promise<FixtureRunOutcome | undefined> => {
  const engine = runEngine(env);
  for (;;) {
    // One look after another, as the run goes on.
    // oxlint-disable-next-line no-await-in-loop
    const status = await engine.status(run.runId);
    // Its test is over: nothing more is told of it, its removal included.
    if (stopped()) {
      return undefined;
    }
    if (status?.status === "complete") {
      try {
        return {
          status: "completed",
          result: resultAsDeclared(run.returns, status.output),
        };
      } catch (error) {
        return failed(codeOf(error));
      }
    }
    if (status?.status === "errored") {
      return failed(status.error.code ?? null, status.error.message);
    }
    if (status?.status === "terminated") {
      return { status: "cancelled" };
    }
    if (Date.now() + pollMs > until) {
      return undefined;
    }
    // oxlint-disable-next-line no-await-in-loop
    await scheduler.wait(pollMs);
  }
};

/** The engine's statuses of a run that has ended. */
const ended: ReadonlySet<string> = new Set([
  "complete",
  "errored",
  "terminated",
]);

/**
 * Whether test run `run` waits for something (a sleep, a wait, a
 * decision) or has ended, asking the engine until it does, `until` (ms
 * since the epoch) passes, or `stopped` says its test is over: false when
 * neither by then.
 */
export const fixtureRunWaits = async (
  env: Env,
  run: FixtureRunStarted,
  { until, stopped }: { until: number; stopped: () => boolean }
): Promise<boolean> => {
  const engine = runEngine(env);
  for (;;) {
    // One look after another, as the run goes on.
    // oxlint-disable-next-line no-await-in-loop
    const status = await engine.status(run.runId);
    if (stopped()) {
      return false;
    }
    if (status !== undefined && ended.has(status.status)) {
      return true;
    }
    // Waiting, and nothing due to wake it at once: settled where it waits.
    if (
      status?.status === "waiting" &&
      // oxlint-disable-next-line no-await-in-loop -- one look after another
      (await engine.fixtureWaits(run.runId))
    ) {
      return true;
    }
    if (Date.now() + pollMs > until) {
      return false;
    }
    // oxlint-disable-next-line no-await-in-loop
    await scheduler.wait(pollMs);
  }
};

/** A task's ID, as a workflow names it: what `completedCount` takes. */
const taskIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u);

/**
 * How many times test run `runId`'s task `task` completed its step (the
 * run host's `<id>:task`): each time the engine recorded it so, once
 * however often it was replayed.
 */
export const fixtureTaskCompletions = async (
  env: Env,
  runId: string,
  task: unknown
): Promise<number> => {
  const parsed = taskIdSchema.safeParse(task);
  if (!parsed.success) {
    throw functionErrors.create("contract.invalid_args");
  }
  return (
    (await runEngine(env).succeededSteps(
      runId,
      `${parsed.data}${taskStepSuffix}`
    )) ?? 0
  );
};

/** Most left-behind test runs one sweep removes. */
const sweepPage = 50;

/**
 * Removes the test runs whose test's time was up before `now`, longest
 * recorded first, a page at a time: runs whose test died before its
 * session removed them.
 */
export const sweepFixtureRuns = async (env: Env, now: Date): Promise<void> => {
  const left = await drizzle(env.DB)
    .select({ runId: appTestRuns.runId })
    .from(appTestRuns)
    .where(lt(appTestRuns.deadline, now))
    .orderBy(asc(appTestRuns.createdAt))
    .limit(sweepPage);
  await discardFixtureRuns(
    env,
    left.map(({ runId }) => runId)
  );
};
