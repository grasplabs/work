import { isPlainObject } from "@grasp-os/shared/json";

import { readRejection } from "./call-answers.ts";
import { clientError, issueDetails, withReceiptLink } from "./client-error.ts";
import type { ClientInternals } from "./client-internals.ts";
import type { DecisionTransport } from "./client-transport.ts";
import { fences } from "./refusals.ts";
import { validateValue } from "./value-interpreter.ts";
import type { ReadWorkflow } from "./workflow-reference-read.ts";

// A person's answer to a decision a run is held at, from a page: never a
// mutation of the App's, but through the trusted host (`decisions`), which
// has the person confirm the answer in its own UI before it records it
// with a one-use confirmation the page never holds.

/** The longest ID the host gives a wait. */
const maxWaitIdLength = 256;

/**
 * Sends `answer` to decision `decision` of run `runId` through the
 * trusted host: an outcome lost on the way is `decision.outcome_unknown`,
 * carrying a link that sends this very answer again (`withReceiptLink`),
 * so a form asked again never makes a fresh one. A refusal that fences
 * clears the client, unless a fence came since the answer was sent.
 */
const answered = async (
  internals: ClientInternals,
  decisions: DecisionTransport,
  runId: string,
  decision: string,
  answer: { readonly approved: boolean; readonly payload: unknown }
): Promise<void> => {
  const startedUnder = internals.fences();
  try {
    await decisions.respond(runId, decision, answer);
  } catch (error) {
    const settled = readRejection(error);
    if (settled.kind !== "failed") {
      throw withReceiptLink(
        clientError("decision.outcome_unknown"),
        async () => {
          await answered(internals, decisions, runId, decision, answer);
        }
      );
    }
    if (fences(settled.error.code)) {
      internals.fence(settled.error, startedUnder);
    }
    throw settled.error;
  }
};

/**
 * Answers the decision `wait` holds run `runId` of `read` at, with
 * `response`. `wait` must be a decision wait of this very workflow's (its
 * key one of the reference's decisions), and `response.value` what that
 * decision's value schema takes. Never sent again on its own: an answer
 * whose outcome is lost is `decision.outcome_unknown`, and the same answer
 * given again is the recorded one, never a second.
 */
export const respondToDecision = async (
  internals: ClientInternals,
  read: ReadWorkflow,
  runId: string,
  wait: unknown,
  response: unknown
): Promise<void> => {
  const decision =
    isPlainObject(wait) &&
    wait.kind === "decision" &&
    typeof wait.key === "string"
      ? read.decisions.get(wait.key)
      : undefined;
  if (
    decision === undefined ||
    !isPlainObject(wait) ||
    typeof wait.id !== "string" ||
    wait.id.length === 0 ||
    wait.id.length > maxWaitIdLength
  ) {
    throw clientError("contract.invalid_request");
  }
  if (!isPlainObject(response) || typeof response.approved !== "boolean") {
    throw clientError("contract.invalid_args");
  }
  const accepted = validateValue(decision.value, response.value);
  if (accepted.issues !== undefined) {
    throw clientError("contract.invalid_args", {
      issues: issueDetails(accepted.issues),
    });
  }
  const { decisions } = internals;
  if (decisions === undefined) {
    throw clientError("decision.unavailable");
  }
  await answered(internals, decisions, runId, wait.id, {
    approved: response.approved,
    payload: accepted.value,
  });
};
