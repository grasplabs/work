/**
 * The vars a placed client's core is uploaded with (src/hosting/operation.ts):
 * what the admin derives for it (src/deploy/core-config.ts), each replaced
 * by the client's setting of the same name, its other settings, how it
 * reaches its models (src/deploy/model-transport.ts), and the change core
 * records, checked as core would take them.
 */
import { deploymentConfigVars } from "@grasp-os/shared/deployment-config";
import type { PlatformChange } from "@grasp-os/shared/platform-change";
import { eq } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { clients, settings } from "../db/schema.ts";
import { checkDeployedConfig, onboardingSender } from "./core-config.ts";
import { DeployError } from "./errors.ts";
import {
  clientModelResidency,
  platformModelTransport,
  withModelTransport,
} from "./model-transport.ts";

const configVarNames: ReadonlySet<string> = new Set(deploymentConfigVars);

/**
 * The only address client `clientId`'s mail may be from: the onboarding
 * sender's, which its `EMAIL` binding is locked to.
 */
export const mailSenderOf = (
  context: { router: { domain: string } },
  clientId: string
): string => onboardingSender(clientId, context.router.domain).address;

/**
 * `vars` with client's monthly model spend ceiling, `euros`, as its model
 * gateway's deployment budget (core's src/model-budgets.ts), which the
 * gateway enforces before every provider request (GRA-141). A setting's
 * own deployment budget stays only where it's lower, so no setting raises
 * the ceiling. The gateway counts providers' list prices in US dollars:
 * the euros go in as dollars, and since a euro is worth at least about a
 * dollar, spend never passes the ceiling in euros. Without a gateway, core
 * makes no model call, so there's nothing to bound.
 */
export const withSpendCeiling = (
  vars: Readonly<Record<string, unknown>>,
  euros: number
): Record<string, unknown> => {
  const gateway = vars.MODEL_GATEWAY;
  if (typeof gateway !== "object" || gateway === null) {
    return { ...vars };
  }
  const budgets: unknown = Reflect.get(gateway, "budgets");
  const set: unknown =
    typeof budgets === "object" && budgets !== null
      ? Reflect.get(budgets, "deployment")
      : undefined;
  const setLimit: unknown =
    typeof set === "object" && set !== null
      ? Reflect.get(set, "limit")
      : undefined;
  const setAlert: unknown =
    typeof set === "object" && set !== null
      ? Reflect.get(set, "alertAt")
      : undefined;
  return {
    ...vars,
    MODEL_GATEWAY: {
      ...gateway,
      budgets: {
        ...(typeof budgets === "object" && budgets !== null ? budgets : {}),
        deployment: {
          limit:
            typeof setLimit === "number" ? Math.min(setLimit, euros) : euros,
          alertAt: typeof setAlert === "number" ? setAlert : 80,
        },
      },
    },
  };
};

/** Setting `key`'s value, stored as JSON; `setting_invalid` when it isn't. */
const settingValue = (key: string, value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    // Not the parser's message: it quotes the value.
    throw new DeployError("setting_invalid", `The setting ${key} isn't JSON`);
  }
};

/**
 * Client `clientId`'s core vars from its `derived` config: each replaced
 * by the client's setting of the same name, its other settings, and
 * `change` as `PLATFORM_CHANGE`, its model transport for its jurisdiction's
 * residency (`withModelTransport`), its model spend ceiling as its
 * gateway's deployment budget (`withSpendCeiling`), checked as
 * `checkDeployedConfig` says, its
 * `MAIL_FROM` against `mailSender`, the address its mail is locked to.
 */
export const configuredCoreVars = async (
  db: AdminDatabase,
  clientId: string,
  derived: Readonly<Record<string, unknown>>,
  change: PlatformChange,
  mailSender: string
): Promise<Record<string, unknown>> => {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.clientId, clientId));
  const unknown = rows.find(({ key }) => !configVarNames.has(key));
  if (unknown !== undefined) {
    throw new DeployError(
      "unknown_setting",
      `The setting ${unknown.key} isn't a deployment config var`
    );
  }
  const client = await db
    .select({ ceiling: clients.modelSpendCeiling })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    throw new Error(`No client ${clientId}`);
  }
  const residency = await clientModelResidency(db, clientId);
  const vars = withSpendCeiling(
    withModelTransport(
      {
        ...derived,
        ...Object.fromEntries(
          rows.map(({ key, value }): [string, unknown] => [
            key,
            settingValue(key, value),
          ])
        ),
        PLATFORM_CHANGE: change,
      },
      {
        residency,
        platformDefault: await platformModelTransport(db, residency),
        gatewaySet: rows.some(({ key }) => key === "MODEL_GATEWAY"),
      }
    ),
    client.ceiling
  );
  // The config that goes out, settings included: never a SIGN_IN no admin
  // can sign in with, nor a var core can't parse, nor a MAIL_FROM its EMAIL
  // binding won't send from.
  checkDeployedConfig(clientId, vars, mailSender);
  return vars;
};
