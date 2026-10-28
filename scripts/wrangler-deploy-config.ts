/**
 * What `wrangler-deploy.ts` deploys: a Worker's config with the ids
 * wrangler can't look up filled in, kept apart from the deploy so it can
 * be tested without an account.
 */

/** The `store_id` a config names instead of a real one. */
export const storePlaceholder = '"account-secrets-store"';
/** The KV `id` a config names instead of the router's map's. */
export const hostsPlaceholder = '"router-hosts-namespace"';

/** How the ids are looked up, and a config's secrets checked against the store. */
export interface ConfigLookups {
  /** The account's Secrets Store id. */
  storeId: () => Promise<string>;
  /** The router's hostname map's KV namespace id. */
  hostsId: () => Promise<string>;
  /** `config` without its bindings to optional secrets store `id` lacks. */
  withStoredSecrets: (config: string, id: string) => Promise<string>;
}

/**
 * `text`, a Worker's config, with each placeholder it names filled in by
 * `lookups`, and its Secrets Store bindings checked against that store.
 * Only what a config names is looked up: one with no placeholder (a
 * Worker that binds neither the store nor the router's map, such as the
 * connect gateway) comes back as it is.
 */
export const filledConfig = async (
  text: string,
  lookups: ConfigLookups
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
  return store === undefined
    ? filled
    : await lookups.withStoredSecrets(filled, store);
};
