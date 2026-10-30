/**
 * Grasp's Discord bot's own settings, as the bot (src/admin/discord.ts)
 * and Platform's Readiness (src/admin/readiness.ts) both read them: plain,
 * with nothing of the bot itself, so Readiness doesn't pull the bot's chat
 * runtime into a page, and the two never read a setting differently.
 */
import { z } from "zod";

/** A Discord id (a snowflake). */
export const snowflake = z.string().regex(/^\d{1,20}$/u);

/**
 * The application's public key, hex, from `DISCORD_PUBLIC_KEY`: what
 * every interaction Discord posts is signed with. Trimmed, as a value
 * pasted into wrangler.jsonc can carry spaces; empty while unset.
 */
export const discordPublicKey = (
  env: Pick<Env, "DISCORD_PUBLIC_KEY">
): string => env.DISCORD_PUBLIC_KEY?.trim() ?? "";

/** The Discord user ids that are Grasp's staff, from `DISCORD_STAFF_IDS`. */
export const staffIds = (
  env: Pick<Env, "DISCORD_STAFF_IDS">
): ReadonlySet<string> =>
  new Set(
    (env.DISCORD_STAFF_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => snowflake.safeParse(id).success)
  );
