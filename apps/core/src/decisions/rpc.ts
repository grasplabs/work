import type {
  DecisionAnswerInput,
  DecisionConfirmation,
  DecisionReview,
  DecisionsApi,
  DecisionView,
} from "@grasp-os/shared/decisions";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { requireWorkflowRole } from "../workflow-resources.ts";
import {
  answerDecision,
  confirmDecision,
  decisionFor,
  reviewDecision,
  waitingDecisions,
} from "./decisions.ts";

/** Whether `allows` lets `by` in, an expected refusal saying no. */
const allowed = async (allows: () => Promise<unknown>): Promise<boolean> => {
  try {
    await allows();
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * Whether `by` may open the page of the workflow whose run asks `view`:
 * for someone with a role in it. A decider needs none to answer.
 */
const opensSource = async (
  env: Env,
  by: Identity,
  view: DecisionView
): Promise<boolean> => {
  const { workflowResource } = view;
  return await allowed(
    async () => await requireWorkflowRole(env, by, workflowResource.id, "user")
  );
};

/**
 * A signed-in person's `decisions`: for pages, the decision's page and
 * the inbox.
 * Every call checks the session first and hands the
 * identity that check returned, with its role and teams read now, to the
 * decision functions, which check that person may answer.
 *
 * `confirm` is the trusted host decision UI's alone: the page calls it
 * once the person confirmed an answer in Grasp's own dialog, and an App's
 * page, whose bridge reaches `pages` only, never can.
 */
export class DecisionsRpc extends CoreRpcTarget implements DecisionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async waiting(): Promise<DecisionView[]> {
    return await withPerson(
      this.#check,
      async (by) => await waitingDecisions(this.#env, by)
    );
  }

  async get(decision: string): Promise<DecisionView> {
    return await withPerson(this.#check, async (by) => {
      const view = await decisionFor(this.#env, by, decision);
      // Its source's page is offered only to one who may open it.
      return (await opensSource(this.#env, by, view))
        ? { ...view, opens: true }
        : view;
    });
  }

  async review(
    decision: string,
    answer: DecisionAnswerInput
  ): Promise<DecisionReview> {
    return await withPerson(
      this.#check,
      async (by) => await reviewDecision(this.#env, by, decision, answer)
    );
  }

  async confirm(
    decision: string,
    revision: string,
    answer: DecisionAnswerInput
  ): Promise<DecisionConfirmation> {
    return await withPerson(
      this.#check,
      async (by) =>
        await confirmDecision(this.#env, by, decision, revision, answer)
    );
  }

  async answer(
    decision: string,
    answer: DecisionAnswerInput,
    confirmation?: string
  ): Promise<DecisionView> {
    return await withPerson(
      this.#check,
      async (by) =>
        await answerDecision(this.#env, by, decision, answer, confirmation)
    );
  }
}
