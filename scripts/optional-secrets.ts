/**
 * Secrets a Worker runs without, until someone adds them to the stage's
 * 1Password Environment and runs Deploy platform, which copies them into
 * the store and binds them, by binding name in either stage: the admin's
 * apps' OAuth clients, Stripe, Rooms, Attio and its Discord digest's webhook
 * (apps/admin/wrangler.jsonc). A deploy before they're in the store
 * leaves them unbound, so the store alone doesn't reach the Worker.
 *
 * A module of its own that imports nothing, so a config loaded by Vite's
 * Cloudflare plugin (apps/admin/cloudflare.config.ts) pulls in nothing the
 * Worker loads too: sharing a module such as the names module with the
 * Worker broke the dev server.
 */
export const optionalSecrets: ReadonlySet<string> = new Set([
  "APP_OAUTH_CLIENTS",
  "STRIPE_RESTRICTED_KEY",
  "ROOMS_READ_TOKEN",
  "ATTIO_READ_KEY",
  "DISCORD_DIGEST_WEBHOOK",
]);
