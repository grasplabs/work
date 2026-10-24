/**
 * The admin's local Secrets Store (Miniflare's), filled as deploy-ops
 * fills it (wrangler.jsonc): for each test (test/secrets-store.ts), and for
 * the browser journeys' admin (test/e2e-seed.ts).
 */
import { env } from "cloudflare:workers";

/** What the local Secrets Store (Miniflare) offers to manage a secret. */
export interface SecretsStoreAdmin {
  create: (value: string) => Promise<string>;
  update: (value: string, id: string) => Promise<string>;
  delete: (id: string) => Promise<void>;
  /** The store's secrets: each one's name, and its id as `metadata.uuid`. */
  list: () => Promise<{ name: string; metadata?: { uuid?: string } }[]>;
}

/** The local Secrets Store's admin API for the secret `binding` names. */
export const adminOf = async (
  binding: SecretsStoreSecret
): Promise<SecretsStoreAdmin> => {
  // SAFETY: Miniflare's local Secrets Store binding answers this method with
  // its admin API, whose methods have these signatures.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const admin = Reflect.get(
    binding,
    "SecretsStoreSecret::admin_api"
  ) as () => Promise<SecretsStoreAdmin>;
  return await admin();
};

/**
 * Every secret the admin reads, with its value: the deployer's and
 * tenant admin's tokens as given.
 */
export const adminSecrets = (tokens: {
  deployer: string;
  tenant: string;
}): [SecretsStoreSecret, string][] => [
  [env.TENANT_ADMIN_TOKEN, tokens.tenant],
  [env.DEPLOYER_API_TOKEN, tokens.deployer],
  [env.ROUTER_KEY, "test-router-key"],
  [env.CLIENT_KEY, "test-client-key"],
  [env.ENTRA_CLIENT_SECRET, "entra-secret"],
  [env.MICROSOFT_CLIENT_SECRET, "microsoft-secret"],
  [env.GOOGLE_CLIENT_SECRET, "google-secret"],
  [env.COMPOSIO_API_KEY, "composio-key"],
  [env.APP_OAUTH_CLIENTS, "{}"],
  // Empty, as a store nobody put Stripe's key in reads: a test that
  // reads Stripe sets it (test/admin-billing.test.ts).
  [env.STRIPE_RESTRICTED_KEY, ""],
  // Rooms' token likewise (test/admin-proposal.test.ts).
  [env.ROOMS_READ_TOKEN, ""],
  // Empty too: the digest's tests set it (test/discord-digest.test.ts).
  [env.DISCORD_DIGEST_WEBHOOK, ""],
  // Attio's key likewise (test/admin-crm.test.ts).
  [env.ATTIO_READ_KEY, ""],
];
