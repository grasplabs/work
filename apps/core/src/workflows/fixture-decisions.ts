import { decisionErrors } from "@grasp-os/shared/decisions";
import { isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appTestDecisions, appTestRuns } from "../db/core/schema.ts";
import { decisionEventType } from "../decisions/decisions.ts";
import type { DecisionOutcome } from "../decisions/decisions.ts";
import { bindingsOf } from "../workflow-resources.ts";
import { runEngine } from "./engine.ts";
import { contractOf, requireShape } from "./resource-calls.ts";
import {
  callDenied,
  callInvalid,
  inputOf,
  partsOf,
  promptOf,
  recipientOf,
  responseOf,
  timeoutOf,
} from "./resource-decisions.ts";
import type { BuiltDecision, DecisionAnswer } from "./resource-decisions.ts";

// The decisions a run an App's test started waits for (`workflowTest`,
// fixture-runs.ts): its `grasp.decision` calls, asked of the test's own
// fixture principals, which answer them through `t.as(name).respond`. The
// run waits for one as any run waits for its decision (resource-host.ts,
// `#awaitDecision`); only who is asked, and where the decision is kept, are
// the test's. Threat model, and how each is closed:
//
// - A test's decision reaching a person of the organization: it is kept in
//   `app_test_decisions` alone, never in `workflow_decisions`, so no inbox,
//   signal, notification or decision page lists it, and it asks only a
//   principal of the test's fixture, by name, never a person, team or role.
// - An answer by someone it doesn't ask: only the principal it names
//   answers it (`decision.forbidden` for anyone else), and only one the
//   fixture lets answer through that binding
//   (`workflows.<alias>.deciders.<binding>`), checked as it opens and again
//   as the run takes the outcome. Never the run's own principal (R8): a
//   decision asking them is refused as it opens.
// - A second answer, or one after the deadline or the run's end: an answer
//   is one conditional update of an open decision before its deadline,
//   after the engine says the run goes on; anything else is
//   `decision.closed`, and the first answer stands.
// - The run taking an answer from its wake, or from the isolate: the wake
//   carries nothing; the run reads the outcome from the decision's record
//   in a step of its own, and its call answers only what that step
//   recorded, the value held to the contract's response schema
//   (`takeFixtureDecision`).
// - A replay asking twice: one decision per run and step (its unique
//   index); a step run again finds the one its first attempt opened, and
//   goes on only if it asks exactly the same.
// - A decision outliving its test: it is removed with its run's record
//   (`ON DELETE CASCADE`), which the session and the sweep remove.

/** Who each decision binding covers in a test, by alias: principals' names. */
const fixtureDecidersSchema = z.record(z.string(), z.array(z.string()));

/** A run an App's test started, as its decisions need it. */
export interface FixtureDecisionRun {
  readonly runId: string;
  readonly workflowId: string;
  readonly version: number;
  /** The fixture principal it acts for (`fixture-<name>`). */
  readonly principal: string;
  readonly createdAt: number;
}

/** The fixture principal named `name`, as a run acts for one. */
const principalId = (name: string): string => `fixture-${name}`;

/**
 * The decision binding `alias` that `run`'s version declares: the
 * catalog contract it pinned. A test's run holds no approval, so the
 * contract alone says what its decisions take.
 */
const bindingOf = async (
  env: Env,
  run: FixtureDecisionRun,
  alias: string
): Promise<{ contractId: string; fingerprint: string }> => {
  const versions = await bindingsOf(env, run.workflowId, run.version);
  const declared = versions.get(run.version) ?? [];
  const binding = declared.find((each) => each.alias === alias);
  if (binding?.kind !== "decision") {
    throw callDenied();
  }
  return binding;
};

/**
 * The principals, by name, that `run`'s fixture lets answer through
 * decision binding `alias`; refused once its record is gone (its test
 * ended).
 */
const decidersOf = async (
  env: Env,
  runId: string,
  alias: string
): Promise<readonly string[]> => {
  const row = await drizzle(env.DB)
    .select({ deciders: appTestRuns.deciders })
    .from(appTestRuns)
    .where(eq(appTestRuns.runId, runId))
    .get();
  if (row === undefined) {
    throw operationErrors.create("operation.cancelled");
  }
  const deciders = fixtureDecidersSchema.parse(JSON.parse(row.deciders));
  return Object.hasOwn(deciders, alias) ? (deciders[alias] ?? []) : [];
};

/** The fixture principal `recipients` asks, by name. */
const recipientNameOf = (recipients: Json): string => {
  const { kind, id } = partsOf(recipientOf(recipients));
  if (kind !== "person") {
    throw callInvalid(
      "recipients: In a test, a decision asks one of its fixture's principals, by name."
    );
  }
  return id;
};

/**
 * Opens `run`'s decision for step `step` of task `task`, as `call` asks:
 * its recipient a principal of the test's fixture the binding covers there,
 * never the one the run acts for; its prompt and input what a decision
 * takes. Its ID and deadline; the same step gets the same decision again.
 */
export const openFixtureDecision = async (
  env: Env,
  run: FixtureDecisionRun,
  task: string,
  step: string,
  call: BuiltDecision
): Promise<{ decision: string; deadline: number }> => {
  const binding = await bindingOf(env, run, call.binding);
  const contract = await contractOf(env, binding);
  const response = responseOf(contract);
  const recipient = recipientNameOf(call.recipients);
  const description = promptOf(call.prompt);
  const input = inputOf(contract.input, call.input);
  if (principalId(recipient) === run.principal) {
    throw callInvalid(
      "recipients: The person the run acts for can't answer its decision."
    );
  }
  const deciders = await decidersOf(env, run.runId, call.binding);
  if (!deciders.includes(recipient)) {
    throw callDenied();
  }
  const now = Date.now();
  const db = drizzle(env.DB);
  await db
    .insert(appTestDecisions)
    .values({
      id: crypto.randomUUID(),
      runId: run.runId,
      task,
      step,
      recipient,
      description,
      input,
      response,
      status: "open",
      openedAt: new Date(now),
      expiresAt: new Date(now + timeoutOf(run, call.timeoutMs, now)),
    })
    .onConflictDoNothing({
      target: [appTestDecisions.runId, appTestDecisions.step],
    });
  const opened = await db
    .select()
    .from(appTestDecisions)
    .where(
      and(
        eq(appTestDecisions.runId, run.runId),
        eq(appTestDecisions.step, step)
      )
    )
    .get();
  // A step run again after a crash goes on only with the decision its
  // first attempt opened asking exactly what this attempt built.
  if (
    opened === undefined ||
    opened.task !== task ||
    opened.recipient !== recipient ||
    opened.description !== description ||
    canonicalJson(opened.input) !== canonicalJson(input)
  ) {
    throw callInvalid(
      "input: The decision this step opened before asks something else."
    );
  }
  return { decision: opened.id, deadline: opened.expiresAt.getTime() };
};

/**
 * How `run`'s decision `decision` ended: answered, by whom and how, or not
 * yet. With `close`, a decision still open is closed as timed out first,
 * in a conditional update an answer can't race past.
 */
export const fixtureDecisionOutcome = async (
  env: Env,
  runId: string,
  decision: string,
  close: boolean
): Promise<DecisionOutcome> => {
  const db = drizzle(env.DB);
  const mine = and(
    eq(appTestDecisions.id, decision),
    eq(appTestDecisions.runId, runId)
  );
  if (close) {
    await db
      .update(appTestDecisions)
      .set({ status: "timed_out" })
      .where(and(mine, eq(appTestDecisions.status, "open")));
  }
  const row = await db.select().from(appTestDecisions).where(mine).get();
  if (row === undefined) {
    throw operationErrors.create("operation.cancelled");
  }
  if (
    (row.status === "approved" || row.status === "rejected") &&
    row.decidedBy !== null
  ) {
    return {
      answered: true,
      approved: row.status === "approved",
      by: principalId(row.decidedBy),
      payload: row.payload ?? null,
    };
  }
  return { answered: false };
};

/**
 * What `run`'s decision call through binding `alias` answers, once its
 * decision has `outcome`: whoever answered still one the fixture lets
 * answer through it, and what they answered held to the contract's
 * response schema. A decision nobody answered fails the call
 * (`workflow.decision_timed_out`).
 */
export const takeFixtureDecision = async (
  env: Env,
  run: FixtureDecisionRun,
  alias: string,
  outcome: DecisionOutcome
): Promise<DecisionAnswer> => {
  if (!outcome.answered) {
    throw workflowResourceErrors.create("workflow.decision_timed_out");
  }
  const binding = await bindingOf(env, run, alias);
  const deciders = await decidersOf(env, run.runId, alias);
  if (!deciders.some((name) => principalId(name) === outcome.by)) {
    throw callDenied();
  }
  const contract = await contractOf(env, binding);
  return {
    answered: true,
    approved: outcome.approved,
    by: outcome.by,
    value: requireShape(responseOf(contract), outcome.payload, "value"),
  };
};

/** A task's ID, as a workflow names it. */
const taskIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u);

/** An answer as a test principal gives it (`respond`). */
const answerSchema = z.strictObject({
  task: taskIdSchema,
  approved: z.boolean(),
  value: z.json().optional(),
});

/** How often an answer looks again for the decision it answers, in ms. */
const pollMs = 100;

/** Whether the engine's `status` is of a run that goes on. */
const goesOn = (
  status: Awaited<ReturnType<ReturnType<typeof runEngine>["status"]>>
): boolean =>
  status !== undefined &&
  status.status !== "complete" &&
  status.status !== "errored" &&
  status.status !== "terminated";

/**
 * The open decision of task `task` run `runId` waits for. Until the task
 * first asks one, waits for it while the run goes on, until `until` or
 * `stopped` (`decision.not_found` when it asked none); once its latest was
 * answered or ran out of time with none asked since, `decision.closed`.
 */
const openDecisionOf = async (
  env: Env,
  runId: string,
  task: string,
  { until, stopped }: { until: number; stopped: () => boolean }
) => {
  const db = drizzle(env.DB);
  for (;;) {
    // One look after another, as the run goes on.
    // oxlint-disable-next-line no-await-in-loop
    const [latest] = await db
      .select()
      .from(appTestDecisions)
      .where(
        and(eq(appTestDecisions.runId, runId), eq(appTestDecisions.task, task))
      )
      .orderBy(desc(appTestDecisions.openedAt))
      .limit(1);
    if (latest?.status === "open") {
      return latest;
    }
    // Answered, or out of time, and none asked since: closed now, never
    // waited on, as a second answer to it would be.
    if (latest !== undefined) {
      throw decisionErrors.create("decision.closed");
    }
    // oxlint-disable-next-line no-await-in-loop
    const running = goesOn(await runEngine(env).status(runId));
    if (!running || stopped() || Date.now() + pollMs > until) {
      throw decisionErrors.create("decision.not_found");
    }
    // oxlint-disable-next-line no-await-in-loop
    await scheduler.wait(pollMs);
  }
};

/**
 * Answers, as the fixture principal named `by`, the decision of the task
 * `request` names that run `runId` waits for (a test's `respond`), once
 * the run asks it, until `until` or `stopped`: then wakes the run, which
 * reads the answer from the decision. Refused for anyone it doesn't ask
 * (`decision.forbidden`), an answer its contract doesn't take
 * (`decision.invalid`), and once it was answered, ran out of time or its
 * run ended (`decision.closed`).
 */
export const answerFixtureDecision = async (
  env: Env,
  runId: string,
  by: string,
  request: unknown,
  wait: { until: number; stopped: () => boolean }
): Promise<void> => {
  const answer = answerSchema.safeParse(request);
  if (!answer.success) {
    throw decisionErrors.create("decision.invalid");
  }
  const { task, approved, value = null } = answer.data;
  const open = await openDecisionOf(env, runId, task, wait);
  if (open.recipient !== by) {
    throw decisionErrors.create("decision.forbidden");
  }
  let payload: Json;
  try {
    payload = requireShape(open.response, value, "value");
  } catch (error) {
    if (isExpectedError(error)) {
      throw decisionErrors.create("decision.invalid");
    }
    throw error;
  }
  // Only while the run goes on: one that ended takes no answer.
  if (!goesOn(await runEngine(env).status(runId))) {
    throw decisionErrors.create("decision.closed");
  }
  const now = new Date();
  const [answered] = await drizzle(env.DB)
    .update(appTestDecisions)
    .set({
      status: approved ? "approved" : "rejected",
      decidedBy: by,
      decidedAt: now,
      payload,
    })
    .where(
      and(
        eq(appTestDecisions.id, open.id),
        eq(appTestDecisions.status, "open"),
        eq(appTestDecisions.recipient, by),
        gt(appTestDecisions.expiresAt, now)
      )
    )
    .returning({ id: appTestDecisions.id });
  if (answered === undefined) {
    throw decisionErrors.create("decision.closed");
  }
  // The wake carries nothing: the run reads the answer from the decision.
  await runEngine(env).sendEvent(
    runId,
    decisionEventType(open.id),
    `decision:${open.id}`
  );
};
