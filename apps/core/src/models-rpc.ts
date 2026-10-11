import { actorOf } from "@grasp-os/shared/audit";
import { heldListed } from "@grasp-os/shared/models";
import type {
  HeldDecision,
  HeldHow,
  HeldRequest,
  ModelSettings,
  ModelsApi,
} from "@grasp-os/shared/models";
import { requireAdmin } from "@grasp-os/shared/roles";
import { z } from "zod";

import { budgetMonth, budgetSpend } from "./model-budgets.ts";
import { modelLedger } from "./model-ledger.ts";
import { microsPerDollar } from "./model-prices.ts";
import { gatewaySettings } from "./models.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The model gateway's settings, for admins to read: the allowlist and the
// client's rules (models.ts, model-rules.ts), and this month's spend
// against each budget (model-budgets.ts). The settings are deployment
// config that the console sets, so nothing here changes them. Reads aren't
// audited: the rules are the console's to record, and each call's cost is
// in the audit log already, with its model call.
//
// And the reservations the model ledger set aside because it couldn't read
// them to settle (model-ledger.ts): admins see what they hold, and release
// each or charge it in full, which the ledger audits in their name. Each
// decision answers what it came to: done, or decided before, with what
// stands.

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
      const month = budgetMonth(this.#env);
      const held = await this.#held();
      if (rules === undefined) {
        return { models, rules: { state: "invalid" }, month, held };
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
        held,
      };
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
