/**
 * Secrets a Worker runs without, until someone adds them to the stage's
 * 1Password Environment and runs Deploy platform, which copies them into
 * the store and binds them, by binding name in either stage: the admin's
 * apps' OAuth clients, Grasp's AI provider keys (until one is there, the
 * platform AI features that need it say they aren't configured yet),
 * Stripe and Attio (apps/admin/wrangler.jsonc). A deploy before they're in the store
 * leaves them unbound, so the store alone doesn't reach the Worker.
 *
 * A module of its own that imports nothing, so a config loaded by Vite's
 * Cloudflare plugin (apps/admin/cloudflare.config.ts) pulls in nothing the
 * Worker loads too: sharing a module such as the names module with the
 * Worker broke the dev server.
 */
export const optionalSecrets: ReadonlySet<string> = new Set([
  "APP_OAUTH_CLIENTS",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "ELEVENLABS_API_KEY",
  "STRIPE_RESTRICTED_KEY",
  "ATTIO_READ_KEY",
]);
