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
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { onboardingStore } from "./store.ts";

// What only Grasp's staff do in the onboarding, over `/rpc`: pause the
// interviews and let them run again, and say where the agreements stand.
// Until the agreements are in and while the interviews are paused, no link
// opens and none goes out. The client's admin sees both (`view()`), and
// the audit log has every change, as the staff member who made it.

/** Refuses anyone but Grasp's staff, with `onboarding.staff_only`. */
const requireStaff = (person: Identity): void => {
  if (!person.staff) {
    throw onboardingErrors.create("onboarding.staff_only");
  }
};

/** What only Grasp's staff do in the onboarding. */
export class OnboardingStaffRpc
  extends RpcTarget
  implements OnboardingStaffApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async pause(): Promise<OnboardingView> {
    return await this.#paused(true);
  }

  async resume(): Promise<OnboardingView> {
    return await this.#paused(false);
  }

  async setAgreements(agreements: Agreements): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        agreementsSchema,
        agreements
      );
      return await onboardingStore(this.#env).setAgreements(
        parsed,
        actorOf(person)
      );
    });
  }

  async #paused(paused: boolean): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      return await onboardingStore(this.#env).setPaused(
        paused,
        actorOf(person)
      );
    });
  }
}
