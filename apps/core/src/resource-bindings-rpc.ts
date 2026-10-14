import type {
  BindingApproval,
  ResourceBinding,
  ResourceBindingsApi,
  ResourceBindingsReview,
} from "@grasp-os/shared/resource-bindings";

import {
  approveResourceBinding,
  listResourceBindings,
  reviewResourceBindings,
  revokeResourceBinding,
} from "./resource-bindings.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/**
 * A signed-in person's `resourceBindings`. Each method takes what the
 * client sent as it is: the binding functions validate it, and check the
 * person's role, on every call.
 */
export class ResourceBindingsRpc
  extends CoreRpcTarget
  implements ResourceBindingsApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async approve(approval: BindingApproval): Promise<ResourceBinding> {
    return await withPerson(
      this.#check,
      async (person) =>
        await approveResourceBinding(this.#env, person, approval)
    );
  }

  async revoke(id: string): Promise<ResourceBinding> {
    return await withPerson(
      this.#check,
      async (person) => await revokeResourceBinding(this.#env, person, id)
    );
  }

  async list(app: string): Promise<ResourceBinding[]> {
    return await withPerson(
      this.#check,
      async (person) => await listResourceBindings(this.#env, person, app)
    );
  }

  async review(app: string): Promise<ResourceBindingsReview> {
    return await withPerson(
      this.#check,
      async (person) => await reviewResourceBindings(this.#env, person, app)
    );
  }
}
