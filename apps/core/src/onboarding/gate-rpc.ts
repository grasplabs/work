import { actorOf } from "@grasp-os/shared/audit";
import type {
  GateView,
  OnboardingGateApi,
} from "@grasp-os/shared/onboarding-gate";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { endStaffAccess, gateView } from "./gate.ts";
import { onboardingStore } from "./store.ts";

// The gate over `/rpc` (gate.ts): the company's admin sees where it stands,
// how much Grasp knows and Grasp's staff access, and can end that access.
// Grasp's staff close it, give the go and set how much is enough from
// Grasp's admin (admin-command.ts).

/** The deployment's gate, for its admin to read, and to end Grasp's staff access. */
export class OnboardingGateRpc
  extends CoreRpcTarget
  implements OnboardingGateApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async view(): Promise<GateView> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await this.#view();
    });
  }

  async endStaffAccess(): Promise<GateView> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      // The company's own admin: staff don't end their own access here.
      if (person.staff) {
        throw roleErrors.create("role.forbidden");
      }
      await endStaffAccess(this.#env, actorOf(person));
      return await this.#view();
    });
  }

  async #view(): Promise<GateView> {
    const onboarding = await onboardingStore(this.#env).view();
    return await gateView(this.#env, onboarding);
  }
}
