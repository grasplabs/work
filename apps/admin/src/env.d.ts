// What the admin reads from its env that wrangler.jsonc doesn't set, so
// `wrangler types` can't see it: what local runs and tests set. Every
// setting wrangler.jsonc sets per stage is typed by
// worker-configuration.d.ts alone. Merged into the interface it generates.
interface __BaseEnv_Env {
  /**
   * `none` in tests and local runs, where workerd has no jurisdictions: the
   * Discord bot's state objects are then got without one
   * (src/admin/discord.ts). Never set in wrangler.jsonc; unset or anything
   * else means the EU.
   */
  DURABLE_OBJECT_JURISDICTION?: string;
  /** Local dev only, from .dev.vars: who requests to this machine come from (src/access.ts). */
  DEV_ACCESS_EMAIL?: string;
}
