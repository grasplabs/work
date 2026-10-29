/**
 * Secrets a Worker runs without, until someone puts them in the store, by
 * binding name in either stage: the admin's apps' OAuth clients, the
 * model providers' keys, Stripe, Rooms, Attio and its Discord webhooks
 * (apps/admin/wrangler.jsonc).
 *
 * A module of its own that imports nothing, so a config loaded by Vite's
 * Cloudflare plugin (apps/admin/cloudflare.config.ts) pulls in nothing the
 * Worker loads too: sharing a module such as the names module with the
 * Worker broke the dev server.
 */
export const optionalSecrets: ReadonlySet<string> = new Set([
  "APP_OAUTH_CLIENTS",
  "MODEL_PROVIDER_KEYS",
  "STRIPE_RESTRICTED_KEY",
  "ROOMS_READ_TOKEN",
  "ATTIO_READ_KEY",
  "DISCORD_DIGEST_WEBHOOK",
  "STAFF_ALERTS_WEBHOOK",
]);
