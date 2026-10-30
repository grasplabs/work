/**
 * The vars a placed client's core is uploaded with (src/hosting/operation.ts):
 * what the admin derives for it (src/deploy/core-config.ts) and the
 * platform's AI settings (`PLATFORM_AI`, src/platform-ai.ts), each
 * replaced by the client's setting of the same name, its other settings,
 * and the change core records, checked as core would take them.
 */
import { aiProviderIds, aiProviders } from "@grasp-os/shared/ai-providers";
import type { AiProviderId } from "@grasp-os/shared/ai-providers";
import { deploymentConfigVars } from "@grasp-os/shared/deployment-config";
import { log } from "@grasp-os/shared/log";
import { platformAiSchema } from "@grasp-os/shared/platform-ai";
import type { PlatformChange } from "@grasp-os/shared/platform-change";
import { eq } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { settings } from "../db/schema.ts";
import { platformAiOf, platformAiProviders } from "../platform-ai.ts";
import { MissingStoreSecretError } from "./context.ts";
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

/**
 * The providers Grasp's own key reaches a client's connect for: those
 * among `connect`, the shared secrets a deploy gives connect
 * (src/deploy/context.ts), whose platform secret is there.
 */
export const keyedProviders = (
  connect: Readonly<Record<string, string>> | undefined
): ReadonlySet<AiProviderId> =>
  new Set(
    aiProviderIds.filter((provider) => {
      const name = aiProviders[provider].platformSecret;
      return name !== undefined && connect?.[name] !== undefined;
    })
  );

/**
 * Throws `MissingStoreSecretError` naming the key, recorded as
 * `store_secret_missing: <name>`, unless every platform feature in
 * `PLATFORM_AI` (checked already) sends to a provider in `keyed`: core
 * would fail that feature on every call (`upload.conversion_unavailable`
 * and the like), so it never goes out that way.
 */
const checkPlatformKeys = (
  clientId: string,
  value: unknown,
  keyed: ReadonlySet<AiProviderId>
): void => {
  const parsed = platformAiSchema.safeParse(value);
  if (!parsed.success) {
    return;
  }
  for (const { feature, provider } of platformAiProviders(parsed.data)) {
    const name = aiProviders[provider].platformSecret;
    if (name !== undefined && !keyed.has(provider)) {
      log.warn("deploy.platform_key_missing", { clientId, feature, provider });
      throw new MissingStoreSecretError(name);
    }
  }
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
 * Client `clientId`'s core vars from its `derived` config and the
 * platform's AI settings as `PLATFORM_AI`: each replaced by the client's
 * setting of the same name, its other settings, and `change` as
 * `PLATFORM_CHANGE`, checked as `checkDeployedConfig` says, its
 * `MAIL_FROM` against `mailSender`, the address its mail is locked to, and
 * its `PLATFORM_AI` against `keyed`, the providers Grasp's key reaches its
 * connect for (`keyedProviders`).
 */
export const configuredCoreVars = async (
  db: AdminDatabase,
  clientId: string,
  derived: Readonly<Record<string, unknown>>,
  change: PlatformChange,
  mailSender: string,
  keyed: ReadonlySet<AiProviderId>
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
  // Nor a platform feature on a provider Grasp has no key for.
  checkPlatformKeys(clientId, vars.PLATFORM_AI, keyed);
  return vars;
};
