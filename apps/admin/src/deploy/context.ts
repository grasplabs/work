/**
 * What a deploy works with (`DeployContext`), from the admin's env: the
 * Cloudflare API as the deployer, the releases bucket, the router's
 * hostname map and the secrets from Secrets Store (wrangler.jsonc).
 *
 * Built afresh for each run, so a secret rotated in Secrets Store reaches
 * the next deploy. The token and the secrets stay in the context: a caller
 * running in a run's step never returns it from the step, whose result
 * is stored (threat model R17, CO3).
 */
import {
  clientDomain as stageDomain,
  clientsNamespace,
  stageNamed,
} from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";

import type { ClientDispatcher } from "../clients/core-address.ts";
import { cloudflareApi } from "../cloudflare/api.ts";
import type { CloudflareApi, CloudflareApiOptions } from "../cloudflare/api.ts";
import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { ClientDomainUnsetError } from "./client-domain.ts";
import type { SignInApps } from "./core-config.ts";
import type { RouterHosts, SmokeOptions } from "./router.ts";
import type { DeploySecrets } from "./secrets.ts";

/**
 * Grasp's own AI provider keys, one per provider it pays for its platform
 * features with (conversion, transcription, speech: @grasp-os/shared/
 * platform-ai), as connect's secrets name them (@grasp-os/shared/
 * ai-providers, `platformSecret`).
 */
const platformKeySecrets = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "ELEVENLABS_API_KEY",
] as const;
type PlatformKeySecret = (typeof platformKeySecrets)[number];

/** The secrets every client shares, as their bindings are named. */
type SharedSecret =
  | "ENTRA_CLIENT_SECRET"
  | "MICROSOFT_CLIENT_SECRET"
  | "GOOGLE_CLIENT_SECRET"
  | "COMPOSIO_API_KEY"
  | "APP_OAUTH_CLIENTS"
  | PlatformKeySecret;

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
 *
 * Grasp's AI provider keys go to connect alone, which makes every
 * provider call (connect's src/ai-providers.ts): never to core, which
 * holds no key, and never into the admin's database. And only ever to
 * Grasp Cloud: a deploy runs only in a Cloudflare destination the admin's
 * own deployer reaches (hosting/operation.ts refuses a workerd one,
 * `destination_unsupported`, before it delivers anything). On-prem never
 * gets them: its operator leaves them unset, and its platform features run
 * locally or not at all.
 */
const sharedSecrets: Readonly<Record<string, readonly SharedSecret[]>> = {
  core: ["ENTRA_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"],
  connect: [
    "MICROSOFT_CLIENT_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "COMPOSIO_API_KEY",
    "APP_OAUTH_CLIENTS",
    ...platformKeySecrets,
  ],
};

/** The admin's Secrets Store bindings (wrangler.jsonc). */
export type StoreSecret = {
  [Name in keyof Env]-?: Env[Name] extends SecretsStoreSecret ? Name : never;
}[keyof Env];

/** A Secrets Store secret the admin needs isn't there. */
export class MissingStoreSecretError extends Error {
  /** The secret that isn't there: its name, never a value. */
  readonly secret: StoreSecret;

  constructor(name: StoreSecret) {
    super(`${name} is missing from Secrets Store`);
    this.name = "MissingStoreSecretError";
    this.secret = name;
  }
}

/** What `read` answers, or null when a secret it reads isn't in Secrets Store. */
export const ifStored = async <T>(
  read: () => Promise<T>
): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return null;
    }
    throw error;
  }
};

/**
 * The value of the Secrets Store secret `name`. One that's missing or
 * empty stops the caller (`MissingStoreSecretError`), naming the secret
 * and nothing of its value: Deploy platform copies every one of them in
 * from 1Password, so a gap is a store to fix, not a secret to leave off.
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
 * Optional secret `name`'s value, or undefined while the store has none:
 * not there at all, or empty, or left unbound because the store didn't
 * have it at deploy time (scripts/wrangler-deploy.ts). A read that failed
 * any other way stops the caller as a missing required secret does, so a
 * store that answered badly once is never taken for one without it.
 */
const optionalStoreSecret = async (
  env: Env,
  name: SharedSecret
): Promise<string | undefined> => {
  const binding: SecretsStoreSecret | undefined = env[name];
  if (binding === undefined) {
    return undefined;
  }
  let value = "";
  try {
    value = await binding.get();
  } catch (error) {
    if (!(error instanceof Error && notInStore.test(error.message))) {
      throw new MissingStoreSecretError(name);
    }
  }
  return value === "" ? undefined : value;
};

const isPlatformKey = (name: SharedSecret): name is PlatformKeySecret =>
  platformKeySecrets.some((each) => each === name);

/**
 * A shared secret's value, its stand-in while the store has none, or
 * undefined for one of Grasp's AI provider keys the store doesn't have:
 * connect then goes without it, and a platform feature whose provider has
 * no key says it isn't configured yet, never served by another provider.
 * A deploy never waits on one; Platform's Readiness names a key the
 * features staff chose still lack (src/admin/readiness.ts).
 */
const sharedSecret = async (
  env: Env,
  name: SharedSecret
): Promise<string | undefined> => {
  if (isPlatformKey(name)) {
    return await optionalStoreSecret(env, name);
  }
  const standIn = optionalSharedSecrets[name];
  if (standIn === undefined) {
    return await storeSecret(env, name);
  }
  return (await optionalStoreSecret(env, name)) ?? standIn;
};

/** Each app's shared secrets, by name, read from Secrets Store. */
const sharedValues = async (env: Env): Promise<DeploySecrets["shared"]> => {
  const names = [...new Set(Object.values(sharedSecrets).flat())];
  const values = new Map(
    await Promise.all(
      names.map(async (name): Promise<[string, string | undefined]> => [
        name,
        await sharedSecret(env, name),
      ])
    )
  );
  return Object.fromEntries(
    Object.entries(sharedSecrets).map(([app, secrets]) => [
      app,
      Object.fromEntries(
        secrets.flatMap((name) => {
          const value = values.get(name);
          return value === undefined ? [] : [[name, value]];
        })
      ),
    ])
  );
};

/** Every secret a deploy gives the Workers, read from Secrets Store. */
export const deploySecrets = async (env: Env): Promise<DeploySecrets> => {
  const shared = await sharedValues(env);
  return {
    routerKey: await storeSecret(env, "ROUTER_KEY"),
    clientKey: await storeSecret(env, "CLIENT_KEY"),
    shared,
  };
};

/**
 * The shared secrets, and the key their fingerprints are made with
 * (`sharedSecretPrints`), read from Secrets Store: only these, so a
 * rollback's check of them (src/rollout/rollback.ts) needs nothing else.
 */
export const sharedStoreSecrets = async (
  env: Env
): Promise<Pick<DeploySecrets, "clientKey" | "shared">> => {
  const shared = await sharedValues(env);
  return { clientKey: await storeSecret(env, "CLIENT_KEY"), shared };
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

/** The admin var `value`, trimmed; undefined while it's unset or empty. */
const varOf = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

/**
 * Grasp's OAuth apps' client ids, from the admin's vars (wrangler.jsonc):
 * not secrets, their secrets are shared secrets above.
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
/** What the client's operation works with (src/hosting/operation.ts). */
export interface DeployContext {
  /** The Cloudflare API, as the deployer. */
  api: CloudflareApi;
  db: AdminDatabase;
  /** The releases bucket, read only. */
  store: ReleaseStore;
  /** The secrets to give the Workers, from Secrets Store. */
  secrets: DeploySecrets;
  /**
   * Grasp's OAuth apps' client ids, for core's `SIGN_IN`
   * (src/deploy/core-config.ts); none unless given.
   */
  signInApps?: SignInApps;
  /** The time now: `new Date()` unless a test sets it. */
  now?: () => Date;
  router: {
    /** The router's hostname map. */
    hosts: RouterHosts;
    /** The domain clients are served under: a client is `<id>.<domain>`. */
    domain: string;
    /** How the probe reaches core. */
    smoke?: SmokeOptions;
    /**
     * The clients' dispatch namespace, as the router binds it: how a core
     * placed on Workers for Platforms is reached (hosting/operation.ts).
     */
    dispatcher?: ClientDispatcher;
    /**
     * The namespace `dispatcher` binds: its stage's (`clientsNamespace`).
     * None when the admin's STAGE names no stage, and then it runs no
     * operation (hosting/operation.ts, `stage_unset`).
     */
    namespace?: string;
    /** Relay mode for the clients it deploys (`oauthRelayOf`). */
    oauthRelay?: Stage;
  };
}

/**
 * Relay mode for every client this admin deploys: the stage whose OAuth
 * relay (@grasp-os/shared/oauth-relay) their sign-in and connections come
 * back through. Every client the admin deploys is Grasp-hosted, under its
 * stage's hosted domain, on Grasp's shared OAuth apps, so the relay is
 * always on there. A local run or a test serves clients under a domain of
 * its own, which no relay serves: their IdPs return to their own origin.
 */
export const oauthRelayOf = (env: {
  STAGE?: string;
  CLIENT_DOMAIN?: string;
}): Stage | undefined => {
  const stage = stageNamed(env.STAGE);
  return stage !== undefined && env.CLIENT_DOMAIN?.trim() === stageDomain(stage)
    ? stage
    : undefined;
};

export const deployContext = async (env: Env): Promise<DeployContext> => {
  const domain = clientDomain(env);
  if (domain === null) {
    throw new ClientDomainUnsetError();
  }
  // Exactly staging or production: never production by default, so an
  // admin whose STAGE is missing or misspelt runs no operation anywhere.
  const stage = stageNamed(env.STAGE);
  const relay = oauthRelayOf(env);
  return {
    api: await deployerApi(env),
    db: adminDatabase(env.DB),
    store: env.RELEASES,
    secrets: await deploySecrets(env),
    signInApps: signInApps(env),
    router: {
      hosts: env.ROUTER_HOSTS,
      domain,
      dispatcher: env.DISPATCHER,
      ...(stage === undefined ? {} : { namespace: clientsNamespace(stage) }),
      ...(relay === undefined ? {} : { oauthRelay: relay }),
    },
  };
};
