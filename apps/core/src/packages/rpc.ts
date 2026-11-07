import type {
  DependenciesApi,
  DependencyDecision,
  DependencyRequest,
  DependencyStatus,
  DependencySubjectRef,
} from "@grasp-os/shared/dependencies";
import type { DependencyIntent } from "@grasp-os/shared/packages";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { decideDependency, dependencyStatus } from "./requests.ts";
import { resolveDependencies } from "./resolve.ts";

/**
 * A signed-in person's `dependencies`. Every call checks the session
 * first and hands the identity that check returned on, which is checked
 * again for who the person is now.
 */
export class DependenciesRpc extends CoreRpcTarget implements DependenciesApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async resolve(intent: DependencyIntent): Promise<DependencyRequest> {
    return await withPerson(
      this.#check,
      async (by) => await resolveDependencies(this.#env, by, intent)
    );
  }

  async status(subject: DependencySubjectRef): Promise<DependencyStatus> {
    return await withPerson(
      this.#check,
      async (by) => await dependencyStatus(this.#env, by, subject)
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
}
