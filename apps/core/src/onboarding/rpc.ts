import { actorOf } from "@grasp-os/shared/audit";
import {
  onboardingErrors,
  planSchema,
  rosterSchema,
} from "@grasp-os/shared/onboarding";
import type {
  OnboardingApi,
  OnboardingView,
  PlanInput,
  RosterInput,
} from "@grasp-os/shared/onboarding";
import { requireAdmin } from "@grasp-os/shared/roles";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { dayOf } from "./rules.ts";
import { onboardingStore } from "./store.ts";

// The onboarding over `/rpc`. The company's admin (and Grasp's staff,
// whose access is the admin role) gives the store who works where and the
// plan, and reads back numbers per team, never anyone's words. What only
// Grasp's staff do is in staff-rpc.ts. Everything that comes in is checked
// against the shared schemas before the store sees it.

/** The onboarding, for the client's admin. */
export class OnboardingRpc extends RpcTarget implements OnboardingApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async view(): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await onboardingStore(this.#env).view();
    });
  }

  async saveRoster(roster: RosterInput): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        rosterSchema,
        roster
      );
      return await onboardingStore(this.#env).saveRoster(
        parsed,
        actorOf(person)
      );
    });
  }

  async savePlan(plan: PlanInput): Promise<OnboardingView> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        planSchema,
        plan
      );
      if (parsed.start < dayOf(new Date().toISOString())) {
        throw onboardingErrors.create("onboarding.past");
      }
      const store = onboardingStore(this.#env);
      const { roster } = await store.view();
      if (roster === null) {
        throw onboardingErrors.create("onboarding.no_roster");
      }
      return await store.savePlan(parsed, actorOf(person));
    });
  }
}
