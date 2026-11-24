import { requestErrors } from "@grasp-os/shared/errors";
import { opportunityDismissalSchema } from "@grasp-os/shared/opportunities";
import type {
  OpportunitiesApi,
  Opportunity,
} from "@grasp-os/shared/opportunities";

import {
  dismissOpportunity,
  listOpportunities,
  restoreOpportunity,
} from "./opportunities.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Opportunities over `/rpc` (`session.opportunities`, GRA-1750): for
// admins alone (opportunities.ts), as the signed-in person; like the rest
// of the workspace it refuses a Grasp staff session.

export class OpportunitiesRpc
  extends CoreRpcTarget
  implements OpportunitiesApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<Opportunity[]> {
    return await withPerson(
      this.#check,
      async (person) => await listOpportunities(this.#env, person)
    );
  }

  async dismiss(dismissal: unknown): Promise<void> {
    await withPerson(this.#check, async (person) => {
      const parsed = opportunityDismissalSchema.safeParse(dismissal);
      if (!parsed.success) {
        throw requestErrors.create("request.not_found");
      }
      await dismissOpportunity(this.#env, person, parsed.data);
    });
  }

  async restore(dismissal: unknown): Promise<void> {
    await withPerson(this.#check, async (person) => {
      const parsed = opportunityDismissalSchema.safeParse(dismissal);
      if (!parsed.success) {
        throw requestErrors.create("request.not_found");
      }
      await restoreOpportunity(this.#env, person, parsed.data);
    });
  }
}
