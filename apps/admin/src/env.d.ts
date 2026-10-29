// The admin's settings, each a var in wrangler.jsonc per stage, typed here
// as optional: a stage may leave one unset, and the tests set their own.
// The admin refuses every request without the Access pair. Merged into the
// interface worker-configuration.d.ts generates.
interface __BaseEnv_Env {
  /** The Access application's AUD tag (src/access.ts). */
  CF_ACCESS_AUD?: string;
  /** The Access team's URL, `https://<team>.cloudflareaccess.com` (src/access.ts). */
  CF_ACCESS_ISS?: string;
  /**
   * The domain clients are served under, a client being `<id>.<domain>`
   * (src/deploy/context.ts). No client is provisioned or deployed without it.
   */
  CLIENT_DOMAIN?: string;
  /**
   * Grasp's multi-tenant Entra and Google OAuth apps' client ids, which
   * every client's core signs people in with (src/deploy/core-config.ts):
   * not secrets. A client whose sign-in names an IdP without one isn't
   * deployed.
   */
  ENTRA_CLIENT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
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
   * Grasp's admin's own hostname, e.g. `admin.grasp.example`
   * (src/admin-host.ts). Without it the admin answers on any hostname.
   */
  ADMIN_HOST?: string;
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
