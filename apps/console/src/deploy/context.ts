/**
 * What a deploy works with (`DeployContext`), from the console's env: the
 * Cloudflare API as the deployer, the releases bucket, the router's
 * hostname map and the secrets from Secrets Store (wrangler.jsonc).
 *
 * Built afresh for each run, so a secret rotated in Secrets Store reaches
 * the next deploy. The token and the secrets stay in the context: a caller
 * running in a Workflow step never returns it from the step, whose result
 * is stored (threat model R17, CO3).
 */
import { cloudflareApi } from "../cloudflare/api.ts";
import type { CloudflareApi, CloudflareApiOptions } from "../cloudflare/api.ts";
import { consoleDatabase } from "../db/act.ts";
import type { SignInApps } from "./core-config.ts";
import type { DeployContext } from "./deploy.ts";
import type { DeploySecrets } from "./secrets.ts";

/** The secrets every client shares, as their bindings are named. */
type SharedSecret =
  | "ENTRA_CLIENT_SECRET"
  | "MICROSOFT_CLIENT_SECRET"
  | "GOOGLE_CLIENT_SECRET"
  | "COMPOSIO_API_KEY"
  | "APP_OAUTH_CLIENTS";

/**
 * Which Worker gets which shared secret: core signs people in with the
 * Entra and Google apps, connect connects their Microsoft and Google
 * accounts and reaches Composio. Each is named as the Worker secret it
 * becomes.
 *
 * `APP_OAUTH_CLIENTS` holds Grasp's OAuth apps at every other app, as
 * JSON by provider (`{"<provider>": {"id", "secret"}}`): one secret for
 * them all, so a new app is an entry in the store, never a change here or
 * in connect (connect's src/providers.ts).
 */
const sharedSecrets: Readonly<Record<string, readonly SharedSecret[]>> = {
  core: ["ENTRA_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"],
  connect: [
    "MICROSOFT_CLIENT_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "COMPOSIO_API_KEY",
    "APP_OAUTH_CLIENTS",
  ],
};

/** The console's Secrets Store bindings (wrangler.jsonc). */
type StoreSecret = {
  [Name in keyof Env]-?: Env[Name] extends SecretsStoreSecret ? Name : never;
}[keyof Env];

/** A Secrets Store secret the console needs isn't there. */
export class MissingStoreSecretError extends Error {
  constructor(name: StoreSecret) {
    super(`${name} is missing from Secrets Store`);
    this.name = "MissingStoreSecretError";
  }
}

/**
 * The value of the Secrets Store secret `name`. One that's missing or
 * empty stops the caller (`MissingStoreSecretError`), naming the secret
 * and nothing of its value: deploy-ops writes every one of them, so a gap
 * is a store to fix, not a secret to leave off.
 */
export const storeSecret = async (
  env: Env,
  name: StoreSecret
): Promise<string> => {
  let value = "";
  try {
    value = await env[name].get();
  } catch {
    // The binding throws for a secret the store doesn't have: reported
    // below, by name.
  }
  if (value === "") {
    throw new MissingStoreSecretError(name);
  }
  return value;
};

/**
 * The Cloudflare API as a tenant admin: it only creates client accounts
 * and makes the deployer a member of them (src/provision/workflow.ts).
 */
export const tenantAdminApi = async (env: Env): Promise<CloudflareApi> =>
  cloudflareApi({ token: await storeSecret(env, "TENANT_ADMIN_TOKEN") });

/** The deployer's API token, from Secrets Store. */
export const deployerToken = async (env: Env): Promise<string> =>
  await storeSecret(env, "DEPLOYER_API_TOKEN");

/**
 * The Cloudflare API as the deployer: a member of every client account,
 * its token scoped to what a deploy does.
 */
export const deployerApi = async (
  env: Env,
  options: Pick<CloudflareApiOptions, "waitBudgetMs" | "signal"> = {}
): Promise<CloudflareApi> =>
  cloudflareApi({
    ...options,
    token: await storeSecret(env, "DEPLOYER_API_TOKEN"),
  });

/** The domain clients are served under, or null while none is set. */
export const clientDomain = (env: Env): string | null => {
  const domain = env.CLIENT_DOMAIN?.trim() ?? "";
  return domain === "" ? null : domain;
};

/**
 * Shared secrets a deploy goes on without, with the value it gives
 * instead: `APP_OAUTH_CLIENTS` names no app until one has an OAuth client,
 * and connect refuses OAuth for an app without an entry, so a store that
 * doesn't have it yet must not stop every client's deploy.
 */
const optionalSharedSecrets: Readonly<Partial<Record<SharedSecret, string>>> = {
  APP_OAUTH_CLIENTS: "{}",
};

/** Secrets Store's answer for a secret it doesn't have. */
const notInStore = /not found/iu;

/**
 * A shared secret's value, or its stand-in while the store has none: not
 * there at all, or empty. A read that failed any other way stops the
 * deploy as a missing required secret does, so a store that answered
 * badly once never deploys connect without the apps' clients it has.
 */
const sharedSecret = async (env: Env, name: SharedSecret): Promise<string> => {
  const standIn = optionalSharedSecrets[name];
  if (standIn === undefined) {
    return await storeSecret(env, name);
  }
  let value = "";
  try {
    value = await env[name].get();
  } catch (error) {
    if (!(error instanceof Error && notInStore.test(error.message))) {
      throw new MissingStoreSecretError(name);
    }
  }
  return value === "" ? standIn : value;
};

/** Every secret a deploy gives the Workers, read from Secrets Store. */
export const deploySecrets = async (env: Env): Promise<DeploySecrets> => {
  const names = [...new Set(Object.values(sharedSecrets).flat())];
  const values = new Map(
    await Promise.all(
      names.map(async (name): Promise<[string, string]> => [
        name,
        await sharedSecret(env, name),
      ])
    )
  );
  return {
    routerKey: await storeSecret(env, "ROUTER_KEY"),
    clientKey: await storeSecret(env, "CLIENT_KEY"),
    shared: Object.fromEntries(
      Object.entries(sharedSecrets).map(([app, secrets]) => [
        app,
        Object.fromEntries(
          secrets.map((name) => [name, values.get(name) ?? ""])
        ),
      ])
    ),
  };
};

/**
 * The keys telling a client's core of a platform update needs, read from
 * Secrets Store (src/rollout/activity.ts): only these, so nothing else
 * missing stops it.
 */
export const activityKeys = async (
  env: Env
): Promise<Pick<DeploySecrets, "routerKey" | "clientKey">> => ({
  routerKey: await storeSecret(env, "ROUTER_KEY"),
  clientKey: await storeSecret(env, "CLIENT_KEY"),
});

/** The console var `value`, trimmed; undefined while it's unset or empty. */
const varOf = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

/**
 * Grasp's OAuth apps' client ids, from the console's vars (deploy-ops sets
 * them): not secrets, their secrets are shared secrets above.
 */
export const signInApps = (env: Env): SignInApps => {
  const entraClientId = varOf(env.ENTRA_CLIENT_ID);
  const googleClientId = varOf(env.GOOGLE_CLIENT_ID);
  return {
    ...(entraClientId === undefined ? {} : { entraClientId }),
    ...(googleClientId === undefined ? {} : { googleClientId }),
  };
};

/** Everything a deploy works with, from `env`. Throws while no domain is set. */
export const deployContext = async (env: Env): Promise<DeployContext> => {
  const domain = clientDomain(env);
  if (domain === null) {
    throw new Error("CLIENT_DOMAIN isn't set: no client can be deployed");
  }
  return {
    api: await deployerApi(env),
    db: consoleDatabase(env.DB),
    store: env.RELEASES,
    secrets: await deploySecrets(env),
    signInApps: signInApps(env),
    router: { hosts: env.ROUTER_HOSTS, domain },
  };
};
