import { actorOf } from "@grasp-os/shared/audit";
import {
  agreementsSchema,
  onboardingErrors,
} from "@grasp-os/shared/onboarding";
import type {
  Agreements,
  OnboardingStaffApi,
  OnboardingView,
} from "@grasp-os/shared/onboarding";
import type { StaffAgreements } from "@grasp-os/shared/onboarding-staff";
import type { Identity } from "@grasp-os/shared/rpc";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { onboardingStore } from "./store.ts";

// What only Grasp's staff still do in the onboarding over `/rpc`: say
// where the agreements stand. Everything else staff do to steer an
// onboarding is a command from Grasp's admin (admin-command.ts), and what
// they read of it is the admin's snapshot (admin-snapshot.ts).
//
// The agreements stay here until the admin keeps them: until they are in,
// no link opens and none goes out, so an onboarding can't start without
// them. Once they are in, the links that are due go out at once, not at
// the store's next alarm. The audit log has every change, as the staff
// member who made it.

/** Refuses anyone but Grasp's staff, with `onboarding.staff_only`. */
const requireStaff = (person: Identity): void => {
  if (!person.staff) {
    throw onboardingErrors.create("onboarding.staff_only");
  }
};

/** What only Grasp's staff do in the onboarding. */
export class OnboardingStaffRpc
  extends CoreRpcTarget
  implements OnboardingStaffApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async agreements(): Promise<StaffAgreements> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      return await onboardingStore(this.#env).staffAgreements();
    });
  }

  async setAgreements(agreements: Agreements): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        agreementsSchema,
        agreements
      );
      const store = onboardingStore(this.#env);
      await store.setAgreements(parsed, actorOf(person));
      await store.releaseDue();
      return await store.view();
    });
  }
}
