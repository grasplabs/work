/**
 * A client's own Teams bot, as staff set it on its page: the bot's app id
 * and the tenant it's registered in, both from the bot's registration in
 * the client's own Entra, and the day its client secret expires. The
 * secret itself is sealed apart (src/deploy/sealed-secrets.ts) and never
 * kept here. None of it is secret: it's what the client's IT puts in
 * Teams.
 *
 * Kept on the client's record (`clients.teams_bot`, JSON), as its
 * sign-in is. Every deploy gives its connect `TEAMS_BOT_ID` and
 * `TEAMS_BOT_TENANT_ID`, which it sends as the bot with (connect's
 * src/channels.ts), and its core `TEAMS_BOT_ID`, the audience of every
 * request Teams sends it (core's src/channels/teams.ts). A client without
 * a bot gets neither, and deploys as before.
 */
import { z } from "zod";

/** A bot as its client's record keeps it. */
export const teamsBotSchema = z.object({
  /** The bot's Microsoft app id: its Entra app registration's client id. */
  appId: z.guid(),
  /** The Entra tenant the bot's app is registered in: the client's own. */
  tenantId: z.guid(),
  /** The day its client secret expires, as Entra shows it: `YYYY-MM-DD`. */
  secretExpiresOn: z.iso.date(),
});
export type TeamsBot = z.output<typeof teamsBotSchema>;

/**
 * The bot a client's record keeps (`clients.teams_bot`, JSON), or null for
 * one without: a record that doesn't parse is none, so it can't put
 * anything on a Worker that isn't a bot's id.
 */
export const teamsBotOf = (stored: string | null): TeamsBot | null => {
  if (stored === null) {
    return null;
  }
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  const bot = teamsBotSchema.safeParse(parsed);
  return bot.success ? bot.data : null;
};

/**
 * The vars a deploy gives the Worker `app` for client's bot `bot`: connect
 * sends as it, core checks what Teams sends it is for it. None without a
 * bot, and none for any other Worker.
 */
export const teamsBotVars = (
  app: string,
  bot: TeamsBot | null
): Record<string, string> => {
  if (bot === null) {
    return {};
  }
  if (app === "connect") {
    return { TEAMS_BOT_ID: bot.appId, TEAMS_BOT_TENANT_ID: bot.tenantId };
  }
  if (app === "core") {
    return { TEAMS_BOT_ID: bot.appId };
  }
  return {};
};
