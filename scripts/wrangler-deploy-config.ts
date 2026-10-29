/**
 * What `wrangler-deploy.ts` deploys: a Worker's config with the ids
 * wrangler can't look up filled in, and its Secrets Store bindings checked
 * against the store, kept apart from the deploy so it can be tested
 * without an account.
 */
import { parseJsonc } from "./wrangler-config-rules.ts";

/** The `store_id` a config names instead of a real one. */
export const storePlaceholder = '"account-secrets-store"';
/** The KV `id` a config names instead of the router's map's. */
export const hostsPlaceholder = '"router-hosts-namespace"';

/** How the ids and the store's secrets are looked up. */
export interface ConfigLookups {
  /** The account's Secrets Store id. */
  storeId: () => Promise<string>;
  /** The router's hostname map's KV namespace id. */
  hostsId: () => Promise<string>;
  /** The names of the secrets store `id` has. */
  storedSecrets: (id: string) => Promise<ReadonlySet<string>>;
}

/** What is deployed from the config. */
export interface DeployTarget {
  /**
   * The wrangler environment the deploy picks (`--env`), or undefined for
   * the config's top level: a built config is its stage's already.
   */
  env: string | undefined;
  /** Secrets the Worker runs without, left unbound while the store lacks them. */
  optional: ReadonlySet<string>;
}

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where the deployed Worker's Secrets Store bindings sit in `config`: its
 * environment's own, as wrangler reads them (they aren't inherited from
 * the top level), or the top level's.
 */
const deployedView = (
  config: unknown,
  env: string | undefined
): Record<string, unknown> | undefined => {
  const view = env === undefined ? config : field(field(config, "env"), env);
  return isRecord(view) ? view : undefined;
};

/** The secrets the deployed Worker's Secrets Store bindings name. */
const boundSecrets = (view: Record<string, unknown> | undefined): string[] => {
  const bindings = field(view, "secrets_store_secrets");
  return Array.isArray(bindings)
    ? bindings.flatMap((binding) => {
        const name = field(binding, "secret_name");
        return typeof name === "string" ? [name] : [];
      })
    : [];
};

/**
 * `text`, a Worker's config, with each placeholder it names filled in by
 * `lookups`, and the Secrets Store bindings of what `target` deploys checked
 * against that store. Only what a config names is looked up: one with no
 * placeholder (a Worker that binds neither the store nor the router's map,
 * such as the connect gateway) comes back as it is.
 *
 * Cloudflare refuses a deploy that binds a secret the store doesn't have,
 * and Secrets Store keeps no empty values. So a binding to an optional
 * secret the store doesn't have yet is left out of the deploy: the Worker
 * reads it as not set up. Any other secret the store lacks stops the
 * deploy before it starts, naming all of them. Only the deployed stage's
 * bindings count: the router's staging key needn't be in the store to
 * deploy production, nor production's to deploy staging.
 */
export const filledConfig = async (
  text: string,
  lookups: ConfigLookups,
  target: DeployTarget
): Promise<string> => {
  let filled = text;
  const store = filled.includes(storePlaceholder)
    ? await lookups.storeId()
    : undefined;
  if (store !== undefined) {
    filled = filled.replaceAll(storePlaceholder, JSON.stringify(store));
  }
  if (filled.includes(hostsPlaceholder)) {
    filled = filled.replaceAll(
      hostsPlaceholder,
      JSON.stringify(await lookups.hostsId())
    );
  }
  if (store === undefined) {
    return filled;
  }
  const config = parseJsonc(filled);
  const view = deployedView(config, target.env);
  const bound = boundSecrets(view);
  if (bound.length === 0) {
    return filled;
  }
  const stored = await lookups.storedSecrets(store);
  const missing = bound.filter((name) => !stored.has(name));
  const needed = missing.filter((name) => !target.optional.has(name));
  if (needed.length > 0) {
    throw new Error(
      `Secrets Store ${store} doesn't have ${needed.join(", ")}: put them in, then deploy again`
    );
  }
  if (missing.length === 0 || view === undefined) {
    return filled;
  }
  console.warn(
    `Not in Secrets Store yet, so left unbound: ${missing.join(", ")}`
  );
  const bindings = field(view, "secrets_store_secrets");
  view.secrets_store_secrets = Array.isArray(bindings)
    ? bindings.filter((binding) => {
        const name = field(binding, "secret_name");
        return typeof name !== "string" || stored.has(name);
      })
    : bindings;
  return JSON.stringify(config);
};
