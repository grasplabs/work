import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import {
  appIdSchema,
  storeIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { operationErrors } from "@grasp-os/shared/operations";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { jqProvenance } from "@grasp-os/workflow-expressions/provenance";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "../app-releases.ts";
import type { Release } from "../app-releases.ts";
import { openFixtureStore } from "../data-stores.ts";
import {
  appTestFixtures,
  appTestRuns,
  workflowResourceVersions,
} from "../db/core/schema.ts";
import { callOperation } from "../operations.ts";
import type { Invocation } from "../operations.ts";
import { hostedRelease } from "../release-runner.ts";
import {
  failureOf,
  outputOf,
  pinOf,
  readWorkflowRequest,
  resolveIn,
} from "../screen-workflows.ts";
import {
  consumerFailure,
  fenced,
  fixtureStoreOperation,
} from "../store-operations.ts";
import type { StoreConsumer } from "../store-operations.ts";
import { approvalServing, storeOperationTakes } from "../workflow-bindings.ts";
import { loadWorkflowBuild } from "../workflow-builds.ts";
import { resolveCatalogKeys } from "../workflow-catalog.ts";
import { fixtureParams } from "../workflow-params.ts";
import { bindingsOf, versionContract } from "../workflow-resources.ts";
import { acceptedInput, pinned } from "../workflow-starts.ts";
import { runEngine } from "./engine.ts";
import type { PinnedResourceRun } from "./engine.ts";
import type { RunStep } from "./host.ts";
import { requireShape } from "./resource-calls.ts";
import type { FixtureStoreCall } from "./resource-host.ts";
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
//   models, connections, Knowledge, templates and actions, and any store
//   but its test's. It holds no binding, and writes no approval, grant,
//   receipt or audit entry.
// - Its store calls reach the organization's data, or another App's
//   (`fixtureStoreCall`): a call of a store operation goes to its test's
//   fixture store alone, recorded with the run and checked as the one its
//   test made for the App and version under test, and runs through the
//   release under test. Its alias must be one its version pinned, whose
//   active approval names a store operation (an App's export stays
//   refused); the workflow's own store permission must list it and name
//   the store that release is bound to, which its App owns; and that
//   release must serve it as a public query or mutation of the approved
//   kind and the contract's exact shapes. Those are read, never written:
//   the store the permission names is never opened. A retried step sends
//   its step's key again, so it writes once.
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
// - It runs with, or tells the test, what the organization set: its
//   parameters are its fixture's, or each one's declared default, never the
//   values the organization saved (`fixtureParams`); a failure reaches the
//   test only as a code the platform defines, in its own words
//   (`failureOf`), and an output only as the App's declaration projects it
//   (`outputOf`), as a screen is shown them.
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

/** What a test gives its run's start beside the request. */
export interface FixtureStart {
  /** The parameter values its fixture declares for the workflow `alias` binds. */
  readonly paramsOf: (alias: string) => Readonly<Record<string, unknown>>;
  /** When its test's time is up (ms since the epoch). */
  readonly deadline: number;
  /** Told once its record is written: from then on, it is a run to remove. */
  readonly recorded: () => void;
  /**
   * Its test's fixture store, created if it wasn't yet, which the run's
   * calls of the App's own store operations reach: null for an App with
   * no store.
   */
  readonly store: () => Promise<StoreId | null>;
}

/** A test's run as its start answers it. */
export interface FixtureRunStarted {
  readonly runId: string;
  /** The output the App declares of the workflow (`outputOf`). */
  readonly output: unknown;
}

/**
 * Starts the run of the workflow `request` (a screen's start's text)
 * names, as `principal` of the test of `release`: its run's ID. Refused as
 * a screen's start would be, for anything the release doesn't bind. A
 * start that fails once its run is recorded removes the run again.
 */
export const startFixtureRun = async (
  env: Env,
  release: Release,
  principal: string,
  request: unknown,
  test: FixtureStart
): Promise<FixtureRunStarted> => {
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
  const params = await fixtureParams(
    env,
    workflow,
    pin.version,
    test.paramsOf(resolved.alias)
  );
  const fixtureStoreId = await test.store();
  const runId = crypto.randomUUID();
  // Recorded before the engine hears of it, so nothing runs unrecorded.
  await drizzle(env.DB)
    .insert(appTestRuns)
    .values({
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
      deadline: new Date(test.deadline),
      fixtureStoreId,
    });
  test.recorded();
  try {
    await runEngine(env).createFixture({
      id: runId,
      pinned: { workflow, version: pin.version, manifest: found.manifestHash },
      input: z.json().parse(JSON.parse(input)),
    });
  } catch (error) {
    // The engine may have it, or not: removed either way, its record with
    // it, or left for the sweep.
    await discardFixtureRuns(env, [runId]);
    throw error;
  }
  return { runId, output: resolved.declared.output };
};

const jsonObjectSchema = z.record(z.string(), z.json());

/** A store operation call refused, as any a test's run may not make. */
const unavailable = () => operationErrors.create("resource.unavailable");

/**
 * The store operation calls of test run `row` (`FixtureStoreCall`): only
 * of the App under test's own store, on its test's fixture store, through
 * the release under test (see the header). The call's alias must be one
 * the run's version pinned, whose active approval names a store operation
 * (an App's export, or anything else, stays refused); the workflow's own
 * store permission must list the operation and name the store the release
 * under test is bound to, which its App owns; and that release must serve
 * it as a public query or mutation of exactly the approved kind and the
 * contract's shapes. It then runs as a test's own call does, on the
 * fixture store recorded for the run's App and version, as the fixture's
 * principal, a member and never a builder, with no resources, under the
 * step's key: nothing of it is audited, approved or received in the
 * organization's records, and nothing reaches the store the permission
 * names.
 */
const fixtureStoreCall = (
  env: Env,
  row: typeof appTestRuns.$inferSelect
): FixtureStoreCall => {
  let release: Promise<Release> | undefined;
  return async (call, effect) => {
    const storeId = storeIdSchema.safeParse(row.fixtureStoreId);
    if (!storeId.success) {
      throw unavailable();
    }
    const pinnedBindings = await bindingsOf(
      env,
      row.workflowResourceId,
      row.version
    );
    const pinnedBinding = pinnedBindings
      .get(row.version)
      ?.find(({ alias }) => alias === call.binding);
    if (
      pinnedBinding?.kind !== "operation" ||
      pinnedBinding.resourceId !== null
    ) {
      throw unavailable();
    }
    const approval = await approvalServing(
      env,
      row.workflowResourceId,
      row.version,
      pinnedBinding
    );
    const target = approval?.target;
    // An App's export runs its server code with its own resources: wider
    // than a test's store, so refused (GRA-898).
    if (target?.kind !== "storeOperation") {
      throw unavailable();
    }
    const contracts = await resolveCatalogKeys(env, [pinnedBinding.contractId]);
    const contract = contracts.get(pinnedBinding.contractId);
    if (contract?.fingerprint !== pinnedBinding.fingerprint) {
      throw unavailable();
    }
    const input = requireShape(
      contract.contract.input,
      call.arguments,
      "arguments"
    );
    release ??= loadRelease(env, appIdSchema.parse(row.appId), row.appVersion);
    const underTest = await release;
    const consumer: StoreConsumer = {
      subject: { type: "workflow", id: row.workflowResourceId },
      version: row.version,
      permissionId: target.permissionId,
    };
    const served = await fixtureStoreOperation(
      env,
      consumer,
      underTest,
      target.operation
    );
    if (
      served === undefined ||
      served.operation.kind !== target.operationKind ||
      !storeOperationTakes(served.operation, contract.contract)
    ) {
      throw unavailable();
    }
    // The fixture store its test made for this App and version, and no
    // other: one discarded since (its test ended) is no longer recorded.
    const fixture = await drizzle(env.DB)
      .select({ storeId: appTestFixtures.storeId })
      .from(appTestFixtures)
      .where(
        and(
          eq(appTestFixtures.storeId, storeId.data),
          eq(appTestFixtures.appId, row.appId),
          eq(appTestFixtures.version, row.appVersion)
        )
      )
      .get();
    if (fixture === undefined) {
      throw unavailable();
    }
    const writer = {
      resourceId: row.workflowResourceId,
      resourceVersion: row.version,
    };
    const invocation: Invocation = {
      principal: row.principal,
      consumer: writer,
      writer,
      store: fenced(openFixtureStore(env, storeId.data), effect.requireHolds),
      requestId: crypto.randomUUID(),
      deadline: effect.deadline,
      runId: row.runId,
      // Before each commit: its test still on, and its attempt current.
      authorize: async () => {
        const current = await drizzle(env.DB)
          .select({ deadline: appTestRuns.deadline })
          .from(appTestRuns)
          .where(eq(appTestRuns.runId, row.runId))
          .get();
        if (current === undefined || Date.now() > current.deadline.getTime()) {
          throw operationErrors.create("operation.cancelled");
        }
        effect.requireHolds();
        // A member of the App for the operation, never a builder.
        return { appMember: true, appBuilder: false };
      },
    };
    const result = await callOperation(
      hostedRelease(env, underTest),
      invocation,
      { path: served.operation.path, kind: served.operation.kind },
      input,
      // The step's key, hashed as a consumer's is: a retry writes once.
      { idempotencyKey: await sha256Hex(effect.key) }
    );
    if (!result.ok) {
      throw consumerFailure(result.error);
    }
    return requireShape(contract.contract.output, result.value, "output");
  };
};

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
  // Its test is over: nothing more of it runs.
  if (Date.now() > row.deadline.getTime()) {
    throw operationErrors.create("operation.cancelled");
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
    fixtureStoreCall: fixtureStoreCall(env, row),
  });
};

/**
 * How a test's run ended, as `t.runs.untilTerminal` answers it: a failure
 * as a screen is told one (`failureOf`), an output as the App declares it
 * (`outputOf`).
 */
export type FixtureRunOutcome =
  | { readonly status: "completed"; readonly output: Json }
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

/** A failure as the test is told it: the platform's code and words alone. */
const failed = (code: string | null): FixtureRunOutcome => {
  const told = failureOf({ code });
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
          output: outputOf(run.output, status.output),
        };
      } catch (error) {
        return failed(codeOf(error));
      }
    }
    if (status?.status === "errored") {
      return failed(status.error.code ?? null);
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
