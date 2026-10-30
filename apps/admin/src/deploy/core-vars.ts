/**
 * The vars a placed client's core is uploaded with (src/hosting/operation.ts):
 * what the admin derives for it (src/deploy/core-config.ts) and the
 * platform's AI settings (`PLATFORM_AI`, src/platform-ai.ts), each
 * replaced by the client's setting of the same name, its other settings,
 * and the change core records, checked as core would take them.
 */
import { deploymentConfigVars } from "@grasp-os/shared/deployment-config";
import type { PlatformChange } from "@grasp-os/shared/platform-change";
import { eq } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { settings } from "../db/schema.ts";
import { platformAiOf } from "../platform-ai.ts";
import { checkDeployedConfig, onboardingSender } from "./core-config.ts";
import { DeployError } from "./errors.ts";

const configVarNames: ReadonlySet<string> = new Set(deploymentConfigVars);

/**
 * The only address client `clientId`'s mail may be from: the onboarding
 * sender's, which its `EMAIL` binding is locked to.
 */
export const mailSenderOf = (
  context: { router: { domain: string } },
  clientId: string
): string => onboardingSender(clientId, context.router.domain).address;

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
 * Client `clientId`'s core vars from its `derived` config and the
 * platform's AI settings as `PLATFORM_AI`: each replaced by the client's
 * setting of the same name, its other settings, and `change` as
 * `PLATFORM_CHANGE`, checked as `checkDeployedConfig` says, its
 * `MAIL_FROM` against `mailSender`, the address its mail is locked to.
 *
 * `PLATFORM_AI` goes out whether or not Grasp has a key for the providers
 * it names: a deploy never waits on one. Without it connect has no route
 * for that provider, and core answers that feature as not configured yet
 * (`upload.conversion_unavailable` and the like) until a later deploy
 * brings the key; Platform's Readiness names the key meanwhile.
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
  const vars = {
    ...derived,
    PLATFORM_AI: await platformAiOf(db),
    ...Object.fromEntries(
      rows.map(({ key, value }): [string, unknown] => [
        key,
        settingValue(key, value),
      ])
    ),
    PLATFORM_CHANGE: change,
  };
  // The config that goes out, settings included: never a SIGN_IN no admin
  // can sign in with, nor a var core can't parse, nor a MAIL_FROM its EMAIL
  // binding won't send from.
  checkDeployedConfig(clientId, vars, mailSender);
  return vars;
};
