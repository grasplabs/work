import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { operationErrors } from "@grasp-os/shared/operations";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { jqProvenance } from "@grasp-os/workflow-expressions/provenance";
import { and, eq, inArray, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Release } from "../app-releases.ts";
import { appTestRuns, workflowResourceVersions } from "../db/core/schema.ts";
import { pinOf, readWorkflowRequest, resolveIn } from "../screen-workflows.ts";
import { loadWorkflowBuild } from "../workflow-builds.ts";
import { frozenParams } from "../workflow-params.ts";
import { versionContract } from "../workflow-resources.ts";
import { acceptedInput, pinned } from "../workflow-starts.ts";
import { runEngine } from "./engine.ts";
import type { PinnedResourceRun } from "./engine.ts";
import type { RunStep } from "./host.ts";
import { runActivation } from "./resource-runs.ts";
import type { ResourceRunMemory } from "./resource-runs.ts";

// Runs an App's tests start (spec 28.2, `workflowTest`): a test principal
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
//   against the release under test exactly as a screen's against the
//   current release (`resolveIn`), to the workflow version its seal pinned,
//   and nothing else; input is checked against the declaration and the
//   version's contract, as a start's.
// - It reaches what a test may not: the run acts for the fixture's
//   principal, no member of anything, and its host refuses every call that
//   leaves its own sealed modules (resource-host.ts, `fixture`): Apps,
//   stores, models, connections, Knowledge, templates and actions. It
//   holds no binding, approval or grant, and none is read or written.
// - It takes the organization's quotas or shares: nothing of it is
//   admitted against a lineage or the client's queue (`unadmitted`); its
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

/**
 * Whose share of the sandbox the runs an App's tests start take: their
 * own, neither the App's runs' nor its suites' (app-tests.ts,
 * `appTestOwnerOf`): a suite waits on its run, which mustn't wait for the
 * very place the suite holds.
 */
export const testRunOwnerOf = (app: string): string => `test-runs:${app}`;

/**
 * Starts the run of the workflow `request` (a screen's start's text)
 * names, as `principal` of the test of `release`: its run's ID. Refused as
 * a screen's start would be, for anything the release doesn't bind.
 */
export const startFixtureRun = async (
  env: Env,
  release: Release,
  principal: string,
  request: unknown
): Promise<string> => {
  const command = readWorkflowRequest(request);
  if (!("command" in command) || command.command !== "start") {
    throw operationErrors.create("contract.invalid_request");
  }
  const resolved = await resolveIn(release, command.workflow);
  const pin = pinOf(resolved);
  const declared = schemaFromDescriptor(
    JSON.stringify(resolved.declared.input)
  )["~standard"].validate(command.input);
  if (declared instanceof Promise || declared.issues !== undefined) {
    throw operationErrors.create("contract.invalid_args");
  }
  const workflow = workflowResourceIdSchema.parse(pin.workflowId);
  const found = await pinned(env, workflow, pin.version);
  if (found.buildHash === null) {
    throw workflowResourceErrors.create("workflow.protocol_unsupported");
  }
  const input = acceptedInput(found.inputDescriptor, declared.value);
  const params = await frozenParams(
    env,
    workflow,
    pin.version,
    found.configRevision
  );
  const runId = crypto.randomUUID();
  // Recorded before the engine hears of it, so nothing runs unrecorded.
  await drizzle(env.DB).insert(appTestRuns).values({
    runId,
    appId: release.manifest.resourceId,
    appVersion: release.manifest.resourceVersion,
    workflowResourceId: workflow,
    version: pin.version,
    manifestHash: found.manifestHash,
    buildHash: found.buildHash,
    principal,
    input,
    params,
    createdAt: new Date(),
  });
  await runEngine(env).createFixture({
    id: runId,
    pinned: { workflow, version: pin.version, manifest: found.manifestHash },
    input: z.json().parse(JSON.parse(input)),
  });
  return runId;
};

const jsonObjectSchema = z.record(z.string(), z.json());

/**
 * Runs one activation of the test's run `runId`, as `pin` names it: its
 * record, checked against the pin and the sealed build, then the build's
 * module against a host that reaches nothing outside it
 * (resource-runs.ts, `runActivation`). A run whose record is gone (its
 * test ended) runs nothing.
 */
export const runFixtureWorkflow = async (
  env: Env,
  pin: PinnedResourceRun,
  runId: string,
  engineStep: RunStep,
  memory: ResourceRunMemory
): Promise<unknown> => {
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
  const sealed = await db
    .select({ evaluatorHash: workflowResourceVersions.evaluatorHash })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, pin.workflow),
        eq(workflowResourceVersions.version, pin.version)
      )
    )
    .get();
  if (sealed === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  if (sealed.evaluatorHash !== jqProvenance.sha256) {
    throw workflowResourceErrors.create("workflow.evaluator_changed");
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
  return await runActivation(env, engineStep, memory, {
    run: {
      runId,
      workflowId: pin.workflow,
      version: pin.version,
      principal: row.principal,
      input: z.json().parse(JSON.parse(row.input)),
      params: jsonObjectSchema.parse(JSON.parse(row.params)),
      createdAt: row.createdAt.getTime(),
      build,
      // Its calls go nowhere (resource-host.ts, `fixture`): it binds
      // nothing, and acts for the fixture's principal alone.
      calling: {
        runId,
        workflowId: pin.workflow,
        version: pin.version,
        principal: row.principal,
        invoker: { type: "app", id: row.appId, appVersion: row.appVersion },
        bindings: new Map(),
        restricted: false,
      },
      maxModelCalls: 0,
    },
    output: JSON.stringify(contract.output),
    owner: testRunOwnerOf(row.appId),
    admission: "fixture",
  });
};

/** How a test's run ended, as `t.runs.untilTerminal` answers it. */
export type FixtureRunOutcome =
  | { readonly status: "completed"; readonly output: Json }
  | {
      readonly status: "failed";
      readonly code: string | null;
      readonly message: string;
    }
  | { readonly status: "cancelled" };

/** How often a test asks the engine whether its run ended, in ms. */
const pollMs = 100;

/**
 * How test run `runId` ended, asking the engine until it has or `until`
 * (ms since the epoch) passes: undefined when it hadn't by then.
 */
export const fixtureRunOutcome = async (
  env: Env,
  runId: string,
  until: number
): Promise<FixtureRunOutcome | undefined> => {
  const engine = runEngine(env);
  for (;;) {
    // One look after another, as the run goes on.
    // oxlint-disable-next-line no-await-in-loop
    const status = await engine.status(runId);
    if (status?.status === "complete") {
      return {
        status: "completed",
        output: z.json().safeParse(status.output).data ?? null,
      };
    }
    if (status?.status === "errored") {
      return {
        status: "failed",
        code: status.error.code ?? null,
        message: status.error.message,
      };
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

/** A task's ID, as a workflow names it: what `completedCount` takes. */
const taskIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u);

/**
 * How many times test run `runId`'s task `task` completed its step: each
 * time the engine recorded it so, once however often it was replayed.
 */
export const fixtureTaskCompletions = async (
  env: Env,
  runId: string,
  task: unknown
): Promise<number> => {
  const parsed = taskIdSchema.safeParse(task);
  if (!parsed.success) {
    throw operationErrors.create("contract.invalid_args");
  }
  return (
    (await runEngine(env).succeededSteps(runId, `task:${parsed.data}`)) ?? 0
  );
};

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
    await drizzle(env.DB)
      .delete(appTestRuns)
      .where(inArray(appTestRuns.runId, removed));
  }
};

/** Most left-behind test runs one sweep removes. */
const sweepPage = 50;

/**
 * Removes the test runs recorded before `before` that are still there:
 * runs whose test died before its session removed them.
 */
export const sweepFixtureRuns = async (
  env: Env,
  before: Date
): Promise<void> => {
  const left = await drizzle(env.DB)
    .select({ runId: appTestRuns.runId })
    .from(appTestRuns)
    .where(lt(appTestRuns.createdAt, before))
    .limit(sweepPage);
  await discardFixtureRuns(
    env,
    left.map(({ runId }) => runId)
  );
};
