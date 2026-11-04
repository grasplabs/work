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

/** Whether `by` may open independent workflow `id`'s page. */
const opensWorkflow = async (
  env: Env,
  by: Identity,
  id: string
): Promise<boolean> => {
  try {
    await requireWorkflowRole(env, by, id, "user");
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * A signed-in person's `decisions`: for screens, the decision's page and
 * the inbox.
 * Every call checks the session first and hands the
 * identity that check returned, with its role and teams read now, to the
 * decision functions, which check that person may answer.
 *
 * `confirm` is the trusted host decision UI's alone: the page calls it
 * once the person confirmed an answer in Grasp's own dialog, and an App's
 * screen, whose bridge reaches `screens` only, never can.
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
      const source = view.workflowResource;
      // A decider needn't have a role in the independent workflow that
      // asks: its page is offered only to one who may open it.
      if (
        source === undefined ||
        !(await opensWorkflow(this.#env, by, source.id))
      ) {
        return view;
      }
      return { ...view, workflowResource: { ...source, opens: true } };
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
