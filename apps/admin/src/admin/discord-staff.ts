/**
 * Who Grasp's Discord bot answers (src/admin/discord.ts): plain, with
 * nothing of the bot itself, so Platform's Readiness (src/admin/readiness.ts)
 * reads the same list without pulling the bot's chat runtime into a page.
 */
import { z } from "zod";

/** A Discord id (a snowflake). */
export const snowflake = z.string().regex(/^\d{1,20}$/u);

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
