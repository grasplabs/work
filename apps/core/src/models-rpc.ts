import { actorOf } from "@grasp-os/shared/audit";
import {
  heldListed,
  personLimitSchema,
  personLimitSubjectSchema,
} from "@grasp-os/shared/models";
import type {
  HeldDecision,
  HeldHow,
  HeldRequest,
  ModelMonthSpend,
  ModelSettings,
  ModelsApi,
  PersonLimit,
  PersonLimits,
  PersonLimitSet,
  PersonLimitSubject,
} from "@grasp-os/shared/models";
import { requireAdmin } from "@grasp-os/shared/roles";
import { z } from "zod";

import { budgetPeriods, budgetSpend, monthSpend } from "./model-budgets.ts";
import { modelLedger } from "./model-ledger.ts";
import { microsPerDollar } from "./model-prices.ts";
import { gatewaySettings } from "./models.ts";
import { personLimitsIn, setPersonLimit } from "./person-limits.ts";
import { modelBindingSpend } from "./resource-bindings.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The model gateway's settings, for admins to read: the allowlist and the
// client's rules (models.ts, model-rules.ts), this month's spend against
// each budget, and this month's spend budget or not (model-budgets.ts),
// and each App's model binding with its own caps and what it spent
// (resource-bindings.ts). The settings are deployment config that the
// admin sets, so nothing here changes them. Reads aren't
// audited: the rules are the admin's to record, and each call's cost is
// in the audit log already, with its model call.
//
// And the reservations the model ledger set aside because it couldn't read
// them to settle (model-ledger.ts): admins see what they hold, and release
// each or charge it in full, which the ledger audits in their name. Each
// decision answers what it came to: done, or decided before, with what
// stands.
//
// And the limits the company's admins set per person (person-limits.ts):
// a default, exceptions per person or team, each a monthly limit and
// messages an hour, never above Grasp's budgets. Admins read them with
// each person's spend against theirs, and set or remove them; the ledger
// audits each change in their name.

const heldIdSchema = z.uuid();
const howSchema = z.enum(["release", "charge"]);

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
      const { models, rules } = gatewaySettings(this.#env);
      // One clock for the month and the day, as a request reads them.
      const periods = budgetPeriods(this.#env);
      const { month, day } = periods;
      const [held, bindings] = await Promise.all([
        this.#held(),
        modelBindingSpend(this.#env, periods),
      ]);
      if (rules === undefined) {
        return {
          models,
          rules: { state: "invalid" },
          month,
          day,
          held,
          bindings,
        };
      }
      return {
        models,
        rules: {
          state: "on",
          eu: rules.eu ?? null,
          sensitive: rules.sensitive ?? null,
          budgets: await budgetSpend(this.#env, rules.budgets, month),
        },
        month,
        day,
        held,
        bindings,
      };
    });
  }

  async spend(): Promise<ModelMonthSpend> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await monthSpend(this.#env, budgetPeriods(this.#env).month);
    });
  }

  async held(): Promise<HeldRequest[]> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await this.#held();
    });
  }

  async resolveHeld(id: string, how: HeldHow): Promise<HeldDecision> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const decided = await modelLedger(this.#env).resolveQuarantined(
        heldIdSchema.parse(id),
        howSchema.parse(how),
        actorOf(person)
      );
      if (decided.state === "decided") {
        return {
          state: "decided",
          how: decided.how,
          amount: decided.chargedMicros / microsPerDollar,
        };
      }
      // Told apart from done, so an admin who acted on a request someone
      // else decided sees what stands rather than their own decision.
      if (decided.state === "already_decided") {
        return {
          state: "already_decided",
          how: decided.how,
          amount: decided.chargedMicros / microsPerDollar,
          decidedAt: new Date(decided.decidedAt).toISOString(),
        };
      }
      if (decided.state === "release_only") {
        return { state: "release_only" };
      }
      return { state: "not_held" };
    });
  }

  async limits(): Promise<PersonLimits> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await personLimitsIn(
        this.#env,
        this.#budgets(),
        budgetPeriods(this.#env).month
      );
    });
  }

  async setLimit(
    subject: PersonLimitSubject,
    limit: PersonLimit
  ): Promise<PersonLimitSet> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      return await setPersonLimit(
        this.#env,
        this.#budgets(),
        personLimitSubjectSchema.parse(subject),
        personLimitSchema.parse(limit),
        actorOf(person)
      );
    });
  }

  async removeLimit(subject: PersonLimitSubject): Promise<void> {
    await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      await modelLedger(this.#env).removePersonLimit(
        personLimitSubjectSchema.parse(subject),
        actorOf(person)
      );
    });
  }

  /** Grasp's budgets, as the console set them; `invalid` when they don't parse. */
  #budgets() {
    const { rules } = gatewaySettings(this.#env);
    return rules === undefined ? ("invalid" as const) : rules.budgets;
  }

  async #held(): Promise<HeldRequest[]> {
    const rows = await modelLedger(this.#env).quarantined(heldListed);
    return rows.map(
      ({ id, model, period, reservedMicros, dispatchedAt, releaseOnly }) => ({
        id,
        model,
        period,
        amount: reservedMicros / microsPerDollar,
        sentAt: new Date(dispatchedAt).toISOString(),
        releaseOnly,
      })
    );
  }
}
