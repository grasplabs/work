// What the admin reads from its env that wrangler.jsonc doesn't set, so
// `wrangler types` can't see it: settings neither stage has a value for
// yet, and what local runs and tests set. The settings wrangler.jsonc sets
// per stage (the Access pair, CLIENT_DOMAIN, ADMIN_HOST and the OAuth
// apps' client ids) are typed by worker-configuration.d.ts alone. Merged
// into the interface it generates.
interface __BaseEnv_Env {
  /**
   * Grasp's own client: the deployment whose core answers Ask Grasp with
   * its model gateway (src/admin/ask.ts). Without it the chat says it isn't
   * set up.
   */
  GRASP_CLIENT_ID?: string;
  /**
   * Grasp's Rooms' team origin, e.g. `https://rooms.grasp.example`, which
   * the proposal under Contract is read from (src/proposal/rooms.ts).
   * Without it Rooms isn't read.
   */
  ROOMS_ORIGIN?: string;
  /**
   * Grasp's Discord application's public key, hex: what every interaction
   * Discord posts to the bot is signed with (src/admin/discord.ts). Not a
   * secret. Without it the bot refuses everything.
   */
  DISCORD_PUBLIC_KEY?: string;
  /**
   * The Discord user ids of Grasp's staff, comma-separated: the only people
   * the bot answers (src/admin/discord.ts).
   */
  DISCORD_STAFF_IDS?: string;
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
