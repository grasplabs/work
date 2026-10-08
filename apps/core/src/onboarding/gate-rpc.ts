import { actorOf } from "@grasp-os/shared/audit";
import { onboardingErrors } from "@grasp-os/shared/onboarding";
import { gateThresholds } from "@grasp-os/shared/onboarding-gate";
import type {
  GateThreshold,
  GateView,
  OnboardingGateApi,
} from "@grasp-os/shared/onboarding-gate";
import { requireAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { z } from "zod";

import { signInConfig } from "../auth/config.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { closeGate, gateView, openGate, setGateThreshold } from "./gate.ts";
import { onboardingStore } from "./store.ts";

// The gate over `/rpc` (gate.ts): the company's admin sees where it stands
// and how much Grasp knows; only Grasp's staff close it, give the go, and
// set how much is enough.

const thresholdSchema = z.union(gateThresholds.map((each) => z.literal(each)));

/** Refuses anyone but Grasp's staff, with `onboarding.staff_only`. */
const requireStaff = (person: Identity): void => {
  if (!person.staff) {
    throw onboardingErrors.create("onboarding.staff_only");
  }
};

/** The deployment's gate, for its admin to read and Grasp's staff to move. */
export class OnboardingGateRpc extends RpcTarget implements OnboardingGateApi {
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

  async close(): Promise<GateView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const config = signInConfig(this.#env);
      if (config === undefined) {
        throw onboardingErrors.create("onboarding.invalid");
      }
      await closeGate(this.#env, config, actorOf(person));
      return await this.#view();
    });
  }

  async open(): Promise<GateView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      await openGate(this.#env, actorOf(person));
      return await this.#view();
    });
  }

  async setThreshold(threshold: GateThreshold): Promise<GateView> {
    return await withPerson(this.#check, async (person) => {
      requireStaff(person);
      const parsed = onboardingErrors.parse(
        "onboarding.invalid",
        thresholdSchema,
        threshold
      );
      await setGateThreshold(this.#env, parsed, actorOf(person));
      return await this.#view();
    });
  }

  async #view(): Promise<GateView> {
    const onboarding = await onboardingStore(this.#env).view();
    return await gateView(this.#env, onboarding);
  }
}
