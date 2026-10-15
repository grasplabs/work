import type {
  DecisionAnswerInput,
  DecisionConfirmation,
  DecisionReview,
  DecisionsApi,
  DecisionView,
} from "@grasp-os/shared/decisions";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import {
  answerDecision,
  confirmDecision,
  decisionFor,
  reviewDecision,
} from "./decisions.ts";

/**
 * A signed-in person's `decisions`: for screens and the decision's page.
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

  async get(decision: string): Promise<DecisionView> {
    return await withPerson(
      this.#check,
      async (by) => await decisionFor(this.#env, by, decision)
    );
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
