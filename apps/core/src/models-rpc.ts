import { actorOf } from "@grasp-os/shared/audit";
import { heldListed } from "@grasp-os/shared/models";
import type {
  HeldRequest,
  ModelSettings,
  ModelsApi,
} from "@grasp-os/shared/models";
import { requireAdmin } from "@grasp-os/shared/roles";
import { RpcTarget } from "capnweb";
import { z } from "zod";

import { budgetMonth, budgetSpend } from "./model-budgets.ts";
import { modelLedger } from "./model-ledger.ts";
import { microsPerDollar } from "./model-prices.ts";
import { gatewaySettings } from "./models.ts";
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
// each or charge it in full, which the ledger audits in their name.

const heldIdSchema = z.uuid();
const howSchema = z.enum(["release", "charge"]);

/** The gateway's settings over `/rpc`, for admins, Grasp staff included. */
export class ModelsRpc extends RpcTarget implements ModelsApi {
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

  async resolveHeld(id: string, how: "release" | "charge"): Promise<void> {
    await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      await modelLedger(this.#env).resolveQuarantined(
        heldIdSchema.parse(id),
        howSchema.parse(how),
        actorOf(person)
      );
    });
  }

  async #held(): Promise<HeldRequest[]> {
    const rows = await modelLedger(this.#env).quarantined(heldListed);
    return rows.map(({ id, model, period, reservedMicros, dispatchedAt }) => ({
      id,
      model,
      period,
      amount: reservedMicros / microsPerDollar,
      sentAt: new Date(dispatchedAt).toISOString(),
    }));
  }
}
