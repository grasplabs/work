import type {
  ModelMonthSpend,
  ModelSettings,
  ModelsApi,
} from "@grasp-os/shared/models";
import { requireAdmin } from "@grasp-os/shared/roles";

import { monthSpend, spendMonth } from "./model-spend.ts";
import { modelSettings } from "./models.ts";
import { modelBindingSpend } from "./resource-bindings.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The model gateway's settings, for admins to read: the models the
// organization's calls may use (models.ts), this month's spend
// (model-spend.ts), and what each App's model binding spent
// (resource-bindings.ts). Read-only: clients pay their providers on their
// own keys, and nothing here limits spend. Reads aren't audited: each
// call's cost is in the audit log already, with its model call.

/** The gateway's settings over `/rpc`, for admins, Grasp staff included. */
export class ModelsRpc extends CoreRpcTarget implements ModelsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async settings(): Promise<ModelSettings> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const { models } = await modelSettings(this.#env);
      const month = spendMonth(this.#env);
      const bindings = await modelBindingSpend(this.#env, month);
      return { models, month, bindings };
    });
  }

  async spend(): Promise<ModelMonthSpend> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await monthSpend(this.#env, spendMonth(this.#env));
    });
  }
}
