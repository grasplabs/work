import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appTestRuns } from "../db/core/schema.ts";
import { bindingsOf } from "../workflow-resources.ts";
import type { FixtureDecisionRun } from "./fixture-decisions.ts";
import { requireModelRequest, requireShape } from "./resource-calls.ts";
import type { BuiltCall, Effect } from "./resource-calls.ts";

// The model calls of a run an App's test started (fixture-runs.ts,
// `appTest`): the run's host builds each as it builds a real one, holds
// it to the run's limits, then hands it here in place of `makeCall`
// (sealed-run.ts, `#madeOrServed`). A test's
// run never reaches a real model, the organization's data or its budget.
// Threat model, and how each is closed
// (workflow-test-calls.test.ts tries each):
//
// - A test's model call reaches a model, or spends budget: it is answered
//   with the answer its fixture gives the binding
//   (`workflows.<alias>.models.<binding>`), read from the run's record. The
//   model gateway is never called, so nothing is billed or recorded, and
//   no provider hears of it. A
//   binding the fixture gives no answer fails the run
//   (`workflow.test_unfixtured`): it never falls through to a real call.
// - Any other call leaves the run's code: the host refuses a connector's,
//   Knowledge's, a file's and an event's before
//   it is built or audited (sealed-run.ts, `#call`, by `fixtureCalls`),
//   and `makeCall` refuses every call of a test's run
//   again (`fixture`), so none reaches connect or a model even if the
//   host's gate were wrong.
// - An answer or call the real host wouldn't pass, so a test passes what a
//   real run fails: a model request is checked as every model call is
//   (`requireModelRequest`), and its answer against the task's own output
//   schema (`requireShape`); the run's model call limit and its host calls
//   apply as they do to any run's.
// - It leaves traces in the organization's records: no receipt or audit
//   event of a call is kept, as for a draft's test run (resource-calls.ts,
//   `candidateAnswer`).

/** What a test's fixture gives a run's model bindings. */
const answersSchema = z.record(z.string(), z.json());

const callDenied = () => workflowResourceErrors.create("workflow.call_denied");

const unfixtured = () =>
  workflowResourceErrors.create("workflow.test_unfixtured");

/** `name`'s own entry of `record`, never one of its prototype. */
const ownOf = <Value>(
  record: Readonly<Record<string, Value>>,
  name: string
): Value | undefined =>
  Object.hasOwn(record, name) ? record[name] : undefined;

/** Run `runId`'s record, as its calls need it; `function.cancelled` once gone. */
const recordOf = async (env: Env, runId: string) => {
  const row = await drizzle(env.DB)
    .select({ models: appTestRuns.models })
    .from(appTestRuns)
    .where(eq(appTestRuns.runId, runId))
    .get();
  // Its test ended: nothing more of it is called.
  if (row === undefined) {
    throw operationErrors.create("function.cancelled");
  }
  return row;
};

/**
 * Refuses (`workflow.call_denied`) unless `run`'s version declares `alias`
 * as a model binding: a test's run holds no approval to say more.
 */
const requireModelBinding = async (
  env: Env,
  run: FixtureDecisionRun,
  alias: string
): Promise<void> => {
  const versions = await bindingsOf(env, run.workflowId, run.version);
  const declared = versions.get(run.version) ?? [];
  const binding = declared.find((each) => each.alias === alias);
  if (binding?.kind !== "model") {
    throw callDenied();
  }
};

/** A task's ID, as a workflow names it. */
const taskIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u);

/**
 * Counts one model request of test run `runId`'s task `task`, as the
 * test's model provider answers it: in the run's record, one write that
 * adds one to what it held.
 */
const countModelRequest = async (
  env: Env,
  runId: string,
  task: string
): Promise<void> => {
  const path = `$."${taskIdSchema.parse(task)}"`;
  await drizzle(env.DB)
    .update(appTestRuns)
    .set({
      modelRequests: sql`json_set(${appTestRuns.modelRequests}, ${path}, coalesce(json_extract(${appTestRuns.modelRequests}, ${path}), 0) + 1)`,
    })
    .where(eq(appTestRuns.runId, runId));
};

/** The counts `countModelRequest` keeps. */
const countsSchema = z.record(z.string(), z.number().int().min(0));

/**
 * How many model requests test run `runId`'s task `task` made
 * (`t.effects.modelRequestCount`): as the provider counted them, never
 * the engine.
 */
export const fixtureModelRequests = async (
  env: Env,
  runId: string,
  task: unknown
): Promise<number> => {
  const parsed = taskIdSchema.safeParse(task);
  if (!parsed.success) {
    throw operationErrors.create("contract.invalid_args");
  }
  const row = await drizzle(env.DB)
    .select({ counts: appTestRuns.modelRequests })
    .from(appTestRuns)
    .where(eq(appTestRuns.runId, runId))
    .get();
  if (row === undefined) {
    throw operationErrors.create("function.cancelled");
  }
  return ownOf(countsSchema.parse(JSON.parse(row.counts)), parsed.data) ?? 0;
};

/**
 * The named calls a run an App's test started makes: its decisions
 * (fixture-decisions.ts), and the model calls
 * its test answers (`fixtureCall`). Every other is refused before it is
 * built, on either host of the run.
 */
export const fixtureCalls: ReadonlySet<string> = new Set([
  "grasp.decision",
  "grasp.model",
]);

/**
 * What model call `call` of test run `run`'s task answers (see the
 * header): the answer its fixture gives. Every other call is refused
 * (`resource.unavailable`).
 */
export const fixtureCall = async (
  env: Env,
  run: FixtureDecisionRun,
  task: string,
  call: BuiltCall,
  effect: Effect
): Promise<Json> => {
  const record = await recordOf(env, run.runId);
  if (call.name === "grasp.model") {
    await requireModelBinding(env, run, call.binding);
    requireModelRequest(call);
    const answer = ownOf(
      answersSchema.parse(JSON.parse(record.models)),
      call.binding
    );
    if (answer === undefined) {
      throw unfixtured();
    }
    // Answered: marked as it is, as a real model call is as it goes out,
    // and counted as the provider's request, in the run's record.
    await countModelRequest(env, run.runId, task);
    effect.requireHolds();
    effect.sending?.();
    return requireShape(JSON.stringify(call.outputSchema), answer, "output");
  }
  throw operationErrors.create("resource.unavailable");
};
