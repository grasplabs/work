import type {
  DependenciesApi,
  DependenciesWaiting,
  DependencyApprover,
  DependencyApproverSubject,
  DependencyDecision,
  DependencyProposal,
  DependencyRequest,
  DependencyReview,
  DependencyStatus,
} from "@grasp-os/shared/dependencies";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { grantApprover, listApprovers, revokeApprover } from "./approvers.ts";
import {
  decideDependency,
  dependencyReview,
  dependencyStatus,
  proposeDependencies,
  waitingDependencies,
} from "./requests.ts";

/**
 * A signed-in person's `dependencies`. Every call checks the session
 * first and hands the identity that check returned to the dependency
 * functions, which validate what the client sent and check who the person
 * is now.
 */
export class DependenciesRpc extends RpcTarget implements DependenciesApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async propose(proposal: DependencyProposal): Promise<DependencyRequest> {
    return await withPerson(
      this.#check,
      async (by) => await proposeDependencies(this.#env, by, proposal)
    );
  }

  async status(app: string): Promise<DependencyStatus> {
    return await withPerson(
      this.#check,
      async (by) => await dependencyStatus(this.#env, by, app)
    );
  }

  async waiting(): Promise<DependenciesWaiting> {
    return await withPerson(
      this.#check,
      async (by) => await waitingDependencies(this.#env, by)
    );
  }

  async get(request: string): Promise<DependencyReview> {
    return await withPerson(
      this.#check,
      async (by) => await dependencyReview(this.#env, by, request)
    );
  }

  async decide(
    request: string,
    decision: DependencyDecision
  ): Promise<DependencyRequest> {
    return await withPerson(
      this.#check,
      async (by) => await decideDependency(this.#env, by, request, decision)
    );
  }

  async approvers(): Promise<DependencyApprover[]> {
    return await withPerson(
      this.#check,
      async (by) => await listApprovers(this.#env, by)
    );
  }

  async grantApprover(
    subject: DependencyApproverSubject
  ): Promise<DependencyApprover> {
    return await withPerson(
      this.#check,
      async (by) => await grantApprover(this.#env, by, subject)
    );
  }

  async revokeApprover(id: string): Promise<DependencyApprover> {
    return await withPerson(
      this.#check,
      async (by) => await revokeApprover(this.#env, by, id)
    );
  }
}
