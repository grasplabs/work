import type { AuditEntry } from "@grasp-os/shared/audit";
import { decidersSchema } from "@grasp-os/shared/decisions";
import { isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { organizationId } from "../auth/auth.ts";
import { memberRole } from "../auth/identity.ts";
import { teamMembers, teams } from "../db/core/schema.ts";
import {
  askDecision,
  decisionAsks,
  openDecision,
} from "../decisions/decisions.ts";
import type {
  DecisionOutcome,
  ResourceDecisionRun,
} from "../decisions/decisions.ts";
import { takesPageAnswers } from "./exact-values.ts";
import { requireCallAuthority } from "./resource-authority.ts";
import type {
  CallingRun,
  CandidateBinding,
  FrozenCatalogBinding,
} from "./resource-authority.ts";
import { contractOf, requireShape } from "./resource-calls.ts";

// The decisions a run of an independent workflow waits for: its
// `grasp.decision` calls (platform specification 13.6), each on the
// existing decision service (src/decisions/), through the decision binding
// its start froze (GRA-941). The run host (resource-host.ts) opens one in
// its task's enter step, waits for it durably, holding no isolate, and
// takes its outcome in the task's call step. Threat model, and how each is
// closed:
//
// - A forged answer. Only the decision service records one: a signed-in
//   member it asks, never the run's person, with their one-use
//   confirmation, first answer only, before its deadline, while the run
//   goes on. The run takes the outcome from the decision's row, never from
//   the event that wakes it, nor from the isolate: the call step's answer
//   is the host's (`takeDecision`).
// - A revoked binding. Opening decides the call's authority again
//   (`requireCallAuthority`): the approval active for the run's exact
//   version, the person's role, the workflow live, the start's grant.
//   Taking the outcome decides it again, with whoever answered still one
//   the binding's deciders cover now: anything revoked since refuses the
//   call (`workflow.call_denied`), and the run fails. An answer is never
//   taken as an approval once its authority is gone.
// - Recipients outside the binding. The host builds them from what the
//   build sealed; exactly one, a person, team or role, that the binding's
//   deciders cover now: a team or role it names exactly, a person it
//   names, or one of its teams or roles holds (`coverage`). Never the run's
//   own person (R8), whom the decision also excludes (`starterExcluded`),
//   so a team or role recipient's member who started it can't answer.
// - A replay or retry asking twice. A decision is its run's and step's
//   (`openDecision`, one per run and step): a step run again opens the one
//   it opened, with its deadline. The host records what it opened, so a
//   replay opens nothing.
// - A decline taken for an approval. The outcome is the row's: `approved`
//   is true only for an approved decision; one nobody answered before its
//   deadline closes as timed out, in the same conditional update an answer
//   uses, and the call throws (`workflow.decision_timed_out`): there is no
//   outcome for it at all. What the answer carries (`value`) is held to
//   the contract's response schema, exactly.
// - A test run reaching a person. A test run of a draft's checkpoint opens
//   nothing: its decision is answered from its start's fixtures
//   (`candidateDecision`), checked as a real one is.

/** The longest prompt a decision takes: its description, never cut short. */
const maxPrompt = 500;

/** The most bytes of JSON a decision's input takes: it is shown with it. */
const maxInputBytes = 16 * 1024;

/** The furthest a decision's deadline may be: a year, as a sleep's. */
const maxDecisionMs = 365 * 86_400_000;

/** A decision call, its parts built by the host (resource-host.ts). */
export interface BuiltDecision {
  readonly binding: string;
  readonly recipients: Json;
  readonly prompt: Json;
  readonly input: Json;
  /** How long it takes answers, as its task's timeout says. */
  readonly timeoutMs?: number;
}

/** What a run's decision call answers: its outcome, as spec 13.6 has it. */
export interface DecisionAnswer {
  answered: true;
  approved: boolean;
  by: string;
  value: Json;
}

export const callInvalid = (issue: string) =>
  workflowResourceErrors.create("workflow.call_invalid", { issues: [issue] });

export const callDenied = () =>
  workflowResourceErrors.create("workflow.call_denied");

/** The decision run `run` is, as the decision service names it. */
export const decisionRunOf = (run: CallingRun): ResourceDecisionRun => ({
  kind: "resource",
  runId: run.runId,
  workflow: run.workflowId,
  version: run.version,
});

/** A person, or a person's ID: deciders of one person. */
const personId = /^[\w-]{1,128}$/u;

/**
 * Who `recipients` asks, as deciders (`person:<id>`, `team:<id>` or
 * `role:<role>`): exactly one, a person's ID (a `person` value) or deciders
 * as the decision service names them. `workflow.call_invalid` otherwise.
 */
export const recipientOf = (recipients: Json): string => {
  const list: readonly Json[] = Array.isArray(recipients) ? recipients : [];
  const [recipient] = list;
  if (list.length !== 1 || typeof recipient !== "string") {
    throw callInvalid(
      "recipients: Name exactly one recipient: a person, or a team or role the binding allows."
    );
  }
  if (decidersSchema.safeParse(recipient).success) {
    return recipient;
  }
  if (personId.test(recipient)) {
    return `person:${recipient}`;
  }
  throw callInvalid(
    "recipients: Give a person, or person:, team: or role: as a decision names them."
  );
};

/** Deciders as their kind and ID: everything after the first `:`. */
export const partsOf = (deciders: string): { kind: string; id: string } => {
  const colon = deciders.indexOf(":");
  return { kind: deciders.slice(0, colon), id: deciders.slice(colon + 1) };
};

/**
 * Refuses `recipient` when it is the run's own person, as a person: they
 * never answer its decision (R8).
 */
const requireNotPrincipal = (recipient: string, principal: string): void => {
  const { kind, id } = partsOf(recipient);
  if (kind === "person" && id === principal) {
    throw callInvalid(
      "recipients: The person the run acts for can't answer its decision."
    );
  }
};

/** Whether `userId` is in team `teamId` of the organization now. */
const inTeam = async (
  env: Env,
  userId: string,
  teamId: string
): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.teamId, teamId),
        eq(teams.organizationId, organizationId)
      )
    )
    .get();
  return row !== undefined;
};

/**
 * Whether the binding's `deciders` cover `recipient` now: a team or role
 * they name exactly; a person who is an active member they name, or whose
 * role or one of whose teams they name.
 */
const covers = async (
  env: Env,
  deciders: readonly string[],
  recipient: string
): Promise<boolean> => {
  const { kind, id } = partsOf(recipient);
  if (kind !== "person") {
    return deciders.includes(recipient);
  }
  const role = await memberRole(env.DB, id);
  if (role === undefined) {
    return false;
  }
  for (const decider of deciders) {
    const named = partsOf(decider);
    const holds =
      decider === recipient ||
      (named.kind === "role" && named.id === role) ||
      // oxlint-disable-next-line no-await-in-loop -- at most 16 deciders, each one point lookup
      (named.kind === "team" && (await inTeam(env, id, named.id)));
    if (holds) {
      return true;
    }
  }
  return false;
};

/** The decision binding `alias` of `run`'s start, with its deciders. */
const decisionBinding = (
  run: CallingRun,
  alias: string
): FrozenCatalogBinding & { deciders: readonly string[] } => {
  const binding = run.bindings.get(alias);
  if (binding?.kind !== "decision" || binding.target.kind !== "decision") {
    throw callDenied();
  }
  return { ...binding, deciders: binding.target.deciders };
};

/**
 * The response schema of decision contract `contract`: what an answer's
 * payload must be. A contract without one, or with one taking nothing the
 * decision page sends, could take no answer the run takes: refused before
 * any decision opens (`workflow.call_invalid`).
 */
export const responseOf = (contract: { response?: string }): string => {
  if (contract.response === undefined) {
    throw callInvalid("binding: Its decision contract has no response schema.");
  }
  // The decision page answers with no payload, or with the person's
  // comment (`{ comment }`): a schema taking neither could never be
  // answered, and its run would wait out its deadline.
  if (!takesPageAnswers(contract.response)) {
    throw callInvalid(
      "binding: Its decision contract's response schema takes neither no answer nor { comment }, the only answers a person can give."
    );
  }
  return contract.response;
};

/** `prompt`, as a decision's description: text, at most `maxPrompt` long. */
export const promptOf = (prompt: Json): string => {
  if (
    typeof prompt !== "string" ||
    prompt.trim() === "" ||
    prompt.length > maxPrompt
  ) {
    throw callInvalid(
      `prompt: Give text of at most ${maxPrompt} characters, not blank.`
    );
  }
  return prompt;
};

/** `input`, held to the contract's input schema and a decision's size. */
export const inputOf = (descriptor: string | undefined, input: Json): Json => {
  const checked = requireShape(descriptor, input, "input");
  if (
    new TextEncoder().encode(JSON.stringify(checked)).length > maxInputBytes
  ) {
    throw callInvalid(
      `input: At most ${maxInputBytes} bytes of JSON: a decision shows all of it.`
    );
  }
  return checked;
};

/** Keeps `entry` in the audit log, or fails before anything more. */
const audited = async (env: Env, entry: AuditEntry): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [outboxed(db, entry)]);
};

/** A receipt of `run`'s decision call of task `task`, as a call's is. */
const receiptOf = (
  run: CallingRun,
  task: string,
  binding: FrozenCatalogBinding,
  outcome: string
): AuditEntry => ({
  actor: { type: "system" },
  action: "workflow.run.called",
  target: { type: "workflow_run", id: run.runId },
  detail: {
    workflow: run.workflowId,
    version: run.version,
    task,
    call: "grasp.decision",
    binding: binding.alias,
    approval: binding.approval,
    person: run.principal,
    outcome,
  },
});

/**
 * Runs `work`, `run`'s decision call of task `task` through `binding`,
 * leaving its receipt in the audit log: `opened` or `answered`, or its
 * refusal's code. The outcome's receipt that can't be kept is logged, never
 * put in place of what came of the call.
 */
const receipted = async <T>(
  env: Env,
  run: CallingRun,
  task: string,
  binding: FrozenCatalogBinding,
  done: string,
  work: () => Promise<T>
): Promise<T> => {
  let outcome = done;
  try {
    return await work();
  } catch (error) {
    outcome = isExpectedError(error) ? error.code : "internal.unexpected";
    throw error;
  } finally {
    try {
      await audited(env, receiptOf(run, task, binding, outcome));
    } catch (error) {
      log.error("workflow.run_receipt_unkept", {
        runId: run.runId,
        task,
        outcome,
        ...errorFields(error),
      });
    }
  }
};

/**
 * How long a decision of `run`'s takes answers from now: its task's
 * timeout, or what is left of the host's age limit for its runs (spec
 * 13.7), at most a year. One with no time left is refused.
 */
export const timeoutOf = (
  run: { createdAt: number },
  timeoutMs: number | undefined,
  now: number
): number => {
  const left = timeoutMs ?? run.createdAt + platformLimits.workflowAgeMs - now;
  if (left <= 0) {
    throw callInvalid("timeout: The run has no time left to wait for one.");
  }
  return Math.min(left, maxDecisionMs);
};

/**
 * Opens `run`'s decision for step `step` of task `task`, as `call` asks:
 * once its authority was decided again, its recipient is one the binding
 * covers and never the run's person, its prompt and input what a decision
 * takes. Its ID and deadline; the same step gets the same decision, and
 * deadline, again.
 */
export const openRunDecision = async (
  env: Env,
  run: CallingRun & { createdAt: number },
  task: string,
  step: string,
  call: BuiltDecision
): Promise<{ decision: string; deadline: number }> => {
  const binding = decisionBinding(run, call.binding);
  return await receipted(env, run, task, binding, "opened", async () => {
    await requireCallAuthority(env, run, binding);
    const contract = await contractOf(env, binding);
    const response = responseOf(contract);
    const recipient = recipientOf(call.recipients);
    const description = promptOf(call.prompt);
    const input = inputOf(contract.input, call.input);
    requireNotPrincipal(recipient, run.principal);
    if (!(await covers(env, binding.deciders, recipient))) {
      throw callDenied();
    }
    // Decided again last, nothing awaited of the call after it.
    await requireCallAuthority(env, run, binding);
    const decisionRun = decisionRunOf(run);
    const opened = await openDecision(env, decisionRun, {
      step,
      from: recipient,
      description,
      timeout: timeoutOf(run, call.timeoutMs, Date.now()),
      // Its recipient is the run's choice: whoever it acts for, who may
      // have made it, never answers it (R8).
      starterExcluded: true,
      input,
      // An answer its call couldn't take is refused as it is given, never
      // recorded only to fail the run (`takeDecision` checks it again).
      response,
    });
    // A step run again after a crash finds the decision its first attempt
    // opened, as that attempt built it: the run goes on only if it asks
    // exactly what this attempt built, so what its reviewer answers is
    // what the run asked.
    const asks = await decisionAsks(env, decisionRun, opened.decision);
    if (
      asks.deciders !== recipient ||
      asks.description !== description ||
      canonicalJson(asks.input) !== canonicalJson(input)
    ) {
      throw callInvalid(
        "input: The decision this step opened before asks something else."
      );
    }
    return opened;
  });
};

/**
 * Asks the people `run`'s open decision `decision` is for (`askDecision`):
 * who they are now is audited (`workflow.decision.asked`), and the
 * decision waits for them in their inbox (`waitingDecisions`), with its
 * link. However many they are, the ask never fails the run: past what one
 * audit entry lists, it records how many alone. How many were asked; none
 * once it was answered or closed.
 */
export const askDeciders = async (
  env: Env,
  run: CallingRun,
  decision: string
): Promise<number> => await askDecision(env, decisionRunOf(run), decision);

/**
 * What `run`'s decision call of task `task`, through binding `alias`,
 * answers, once its decision has `outcome`: the outcome as spec 13.6 has
 * it, its authority decided again with whoever answered still one the
 * binding covers, and what they answered held to the contract's response
 * schema. A decision nobody answered fails the call
 * (`workflow.decision_timed_out`).
 */
export const takeDecision = async (
  env: Env,
  run: CallingRun,
  task: string,
  alias: string,
  outcome: DecisionOutcome
): Promise<DecisionAnswer> => {
  const binding = decisionBinding(run, alias);
  return await receipted(env, run, task, binding, "answered", async () => {
    await requireCallAuthority(env, run, binding);
    if (!outcome.answered) {
      throw workflowResourceErrors.create("workflow.decision_timed_out");
    }
    if (!(await covers(env, binding.deciders, `person:${outcome.by}`))) {
      throw callDenied();
    }
    const contract = await contractOf(env, binding);
    const value = requireShape(responseOf(contract), outcome.payload, "value");
    await requireCallAuthority(env, run, binding);
    return {
      answered: true,
      approved: outcome.approved,
      by: outcome.by,
      value,
    };
  });
};

const answerSchema = z.strictObject({
  answered: z.literal(true),
  approved: z.boolean(),
  by: z.string().min(1).max(128),
  value: z.json(),
});

/**
 * Checks a test run's decision call as a real one is checked, sending
 * nothing: its recipient (never `principal`, the person it acts for),
 * prompt and input.
 */
export const checkCandidateDecision = async (
  env: Env,
  bindings: ReadonlyMap<string, CandidateBinding>,
  call: BuiltDecision,
  principal: string
): Promise<void> => {
  const binding = bindings.get(call.binding);
  if (binding?.kind !== "decision") {
    throw callDenied();
  }
  const contract = await contractOf(env, binding);
  responseOf(contract);
  requireNotPrincipal(recipientOf(call.recipients), principal);
  promptOf(call.prompt);
  inputOf(contract.input, call.input);
};

/**
 * What a test run's decision call through binding `alias` answers: the
 * outcome its start gave the binding, exactly a decision's
 * (`{answered: true, approved, by, value}`), its value held to the
 * contract's response schema. No person is asked.
 */
export const candidateDecision = async (
  env: Env,
  bindings: ReadonlyMap<string, CandidateBinding>,
  alias: string
): Promise<DecisionAnswer> => {
  const binding = bindings.get(alias);
  if (binding?.kind !== "decision") {
    throw callDenied();
  }
  if (binding.answer === undefined) {
    throw workflowResourceErrors.create("workflow.candidate_unfixtured");
  }
  const answer = answerSchema.safeParse(binding.answer);
  if (!answer.success) {
    throw callInvalid(
      "output: A decision's answer is { answered: true, approved, by, value }."
    );
  }
  const contract = await contractOf(env, binding);
  return {
    ...answer.data,
    value: requireShape(responseOf(contract), answer.data.value, "value"),
  };
};
