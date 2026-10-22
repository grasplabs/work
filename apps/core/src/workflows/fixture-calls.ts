import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "../app-releases.ts";
import { openFixtureStore } from "../data-stores.ts";
import {
  appTestFixtures,
  appTestRuns,
  businessStores,
} from "../db/core/schema.ts";
import { callOperation } from "../operations.ts";
import { hostedRelease } from "../release-runner.ts";
import { consumerFailure, fenced, servedIn } from "../store-operations.ts";
import { operationServesContract } from "../workflow-bindings.ts";
import { bindingsOf } from "../workflow-resources.ts";
import type { FixtureDecisionRun } from "./fixture-decisions.ts";
import {
  contractOf,
  requireModelRequest,
  requireShape,
} from "./resource-calls.ts";
import type { BuiltCall, Effect } from "./resource-calls.ts";

// The model and store calls of a run an App's test started (fixture-runs.ts,
// `workflowTest`): the run's host builds each as it builds a real one, holds
// it to the run's limits, then hands it here in place of `makeCall`
// (resource-host.ts, `#made`). A test's run never reaches a real model, a
// real store, the organization's data or its budget. Threat model, and how
// each is closed (workflow-test-calls.test.ts tries each):
//
// - A test's model call reaches a model, or spends budget: it is answered
//   with the answer its fixture gives the binding
//   (`workflows.<alias>.models.<binding>`), read from the run's record. The
//   model gateway is never called, so nothing is admitted against a ledger,
//   a budget or a share, nothing is billed, and no provider hears of it. A
//   binding the fixture gives no answer fails the run
//   (`workflow.test_unfixtured`): it never falls through to a real call.
// - A test's store call reaches a real store or real data: it runs only on
//   its test's own fixture store, whose ID its test's session recorded with
//   the run (`app_test_runs.store_id`), read again from the record for each
//   call, never from the isolate or the call. That store must be recorded
//   as a fixture store of the same App and version (`app_test_fixtures`),
//   and listed in no inventory (`business_stores`): a record naming a
//   business store is refused (`resource.unavailable`) before anything
//   opens it, and it is opened as a fixture store, never by `openStore`.
//   No binding, approval, grant or permission is read, so nothing else can
//   name a store.
// - Any other call leaves the run's code: the host refuses a connector's,
//   Knowledge's, a template's, a file's and an action's before it is built
//   (resource-host.ts), and `makeCall` refuses every call of a test's run
//   again (`fixture`), so none reaches connect, a model or a store even if
//   the host's gate were wrong.
// - An answer or call the real host wouldn't pass, so a test passes what a
//   real run fails: a model request is checked as every model call is
//   (`requireModelRequest`), and its answer against the task's own output
//   schema (`requireShape`). A store call is checked against the binding's
//   catalog contract, its arguments before it runs and its answer after,
//   and the run's model call limit and its host calls apply as they do to
//   any run's.
// - It runs what the release doesn't serve, or a shape the contract
//   doesn't take: the operation is the one the fixture names for the
//   binding (`workflows.<alias>.operations.<binding>`), a public query or
//   mutation of the release under test (`servedIn`), whose argument and
//   return shapes are exactly the binding's contract's, as an approval's
//   must be (`operationServesContract`). Anything else is
//   `workflow.call_denied`.
// - It runs with more than a member's rights: as the run's fixture
//   principal, a member of the App, never a builder, as a workflow's store
//   call runs (store-operations.ts), with no resources bound.
// - A retry repeats it: a store call commits under its step's key, as a
//   real one does, and only while its attempt holds its lease (`fenced`).
// - It outlives its test: a call reads the run's record first, and the
//   record goes as the test ends, so a call after finds none
//   (`operation.cancelled`); the store goes with the test's session too,
//   and refuses every call once discarded (`DataStore.discardFixture`).
// - It leaves traces in the organization's records: no receipt or audit
//   event of a call is kept, as for a draft's test run (resource-calls.ts,
//   `candidateAnswer`).

/** What a test's fixture gives a run's model and operation bindings. */
const answersSchema = z.record(z.string(), z.json());
const operationsSchema = z.record(z.string(), z.string());

const callDenied = () => workflowResourceErrors.create("workflow.call_denied");

const unfixtured = () =>
  workflowResourceErrors.create("workflow.test_unfixtured");

/** `name`'s own entry of `record`, never one of its prototype. */
const ownOf = <Value>(
  record: Readonly<Record<string, Value>>,
  name: string
): Value | undefined =>
  Object.hasOwn(record, name) ? record[name] : undefined;

/** Run `runId`'s record, as its calls need it; `operation.cancelled` once gone. */
const recordOf = async (env: Env, runId: string) => {
  const row = await drizzle(env.DB)
    .select({
      appId: appTestRuns.appId,
      appVersion: appTestRuns.appVersion,
      models: appTestRuns.models,
      operations: appTestRuns.operations,
      storeId: appTestRuns.storeId,
    })
    .from(appTestRuns)
    .where(eq(appTestRuns.runId, runId))
    .get();
  // Its test ended: nothing more of it is called.
  if (row === undefined) {
    throw operationErrors.create("operation.cancelled");
  }
  return row;
};

/**
 * The catalog binding `alias` that `run`'s version declares, of the call's
 * kind: a test's run holds no approval, so the contract alone says what
 * the call takes.
 */
const bindingOf = async (
  env: Env,
  run: FixtureDecisionRun,
  alias: string,
  kind: "model" | "operation"
): Promise<{ contractId: string; fingerprint: string }> => {
  const versions = await bindingsOf(env, run.workflowId, run.version);
  const declared = versions.get(run.version) ?? [];
  const binding = declared.find((each) => each.alias === alias);
  if (binding?.kind !== kind || binding.resourceId !== null) {
    throw callDenied();
  }
  return binding;
};

/**
 * Fixture store `id`, if its test recorded it for this App and version
 * and no inventory lists it: never a business store.
 */
const fixtureStoreOf = async (
  env: Env,
  id: string | null,
  app: string,
  version: number
) => {
  const parsed = storeIdSchema.safeParse(id);
  if (!parsed.success) {
    throw operationErrors.create("resource.unavailable");
  }
  const db = drizzle(env.DB);
  const [recorded, listed] = await Promise.all([
    db
      .select({ storeId: appTestFixtures.storeId })
      .from(appTestFixtures)
      .where(
        and(
          eq(appTestFixtures.storeId, parsed.data),
          eq(appTestFixtures.appId, app),
          eq(appTestFixtures.version, version)
        )
      )
      .get(),
    db
      .select({ id: businessStores.id })
      .from(businessStores)
      .where(eq(businessStores.id, parsed.data))
      .get(),
  ]);
  if (recorded === undefined || listed !== undefined) {
    throw operationErrors.create("resource.unavailable");
  }
  return openFixtureStore(env, parsed.data);
};

/**
 * Runs the operation of the release under test that the fixture names for
 * operation binding `call.binding`, on the test's own fixture store, as
 * the run's principal: its answer, as the binding's contract has it.
 */
const fixtureOperation = async (
  env: Env,
  run: FixtureDecisionRun,
  record: Awaited<ReturnType<typeof recordOf>>,
  call: Extract<BuiltCall, { name: "grasp.operation" }>,
  effect: Effect
): Promise<Json> => {
  const binding = await bindingOf(env, run, call.binding, "operation");
  const path = ownOf(
    operationsSchema.parse(JSON.parse(record.operations)),
    call.binding
  );
  if (path === undefined) {
    throw unfixtured();
  }
  const contract = await contractOf(env, binding);
  const input = requireShape(contract.input, call.arguments, "arguments");
  const release = await loadRelease(
    env,
    appIdSchema.parse(record.appId),
    record.appVersion
  );
  const served = servedIn(release, path);
  if (
    served === undefined ||
    !operationServesContract(served.operation, contract)
  ) {
    throw callDenied();
  }
  const store = await fixtureStoreOf(
    env,
    record.storeId,
    record.appId,
    record.appVersion
  );
  const consumer = {
    resourceId: release.manifest.resourceId,
    resourceVersion: release.manifest.resourceVersion,
  };
  const result = await callOperation(
    hostedRelease(env, release),
    {
      principal: run.principal,
      consumer,
      writer: consumer,
      store: fenced(store, effect.requireHolds),
      requestId: crypto.randomUUID(),
      deadline: effect.deadline,
      runId: run.runId,
      // A member of the App, never a builder, as a workflow's store call
      // runs; once its record is gone (its test ended), nothing commits.
      authorize: async () => {
        await recordOf(env, run.runId);
        effect.requireHolds();
        return { appMember: true, appBuilder: false };
      },
    },
    { path, kind: served.operation.kind },
    input,
    // The step's own key, hashed to a submission key's length, as a
    // workflow's real store call sends it.
    { idempotencyKey: await sha256Hex(effect.key) }
  );
  if (!result.ok) {
    throw consumerFailure(result.error);
  }
  return requireShape(contract.output, result.value, "output");
};

/**
 * What model or operation call `call` of test run `run`'s task answers
 * (see the header): a model's answer from its fixture, an operation run on
 * its test's own store. Every other call is refused (`resource.unavailable`).
 */
export const fixtureCall = async (
  env: Env,
  run: FixtureDecisionRun,
  call: BuiltCall,
  effect: Effect
): Promise<Json> => {
  const record = await recordOf(env, run.runId);
  if (call.name === "grasp.model") {
    await bindingOf(env, run, call.binding, "model");
    requireModelRequest(call);
    const answer = ownOf(
      answersSchema.parse(JSON.parse(record.models)),
      call.binding
    );
    if (answer === undefined) {
      throw unfixtured();
    }
    return requireShape(JSON.stringify(call.outputSchema), answer, "output");
  }
  if (call.name === "grasp.operation") {
    return await fixtureOperation(env, run, record, call, effect);
  }
  throw operationErrors.create("resource.unavailable");
};
