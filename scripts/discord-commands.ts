/**
 * Registers Grasp's Discord bot's `/grasp` command (apps/console's
 * src/admin/discord-commands.ts) with its Discord application, replacing
 * whatever commands it had: run once after creating the application, and
 * again whenever the command changes. `vp run discord:commands`, with:
 *
 * - `DISCORD_APPLICATION_ID`: the application's id (General Information);
 * - `DISCORD_BOT_TOKEN`: its bot's token (Bot → Reset Token), from
 *   1Password, never committed;
 * - `DISCORD_GUILD_ID` (optional): Grasp's server's id. With it, the
 *   command is the server's alone and shows at once; without it, it is
 *   global and Discord can take up to an hour to show it.
 *
 * Before it, in the Discord developer portal: create the application, add a
 * bot, and invite it to Grasp's server with the `applications.commands`
 * scope. After it: set the application's Interactions Endpoint URL to the
 * console's `https://<console host>/discord/interactions`, once the console
 * has `DISCORD_PUBLIC_KEY` (the application's public key) and
 * `DISCORD_STAFF_IDS` (staff's Discord user ids, comma-separated) and
 * Access lets that path through.
 */
import { discordCommands } from "../apps/console/src/admin/discord-commands.ts";

const api = "https://discord.com/api/v10";

const required = (name: string): string => {
  const value = process.env[name] ?? "";
  if (value === "") {
    console.error(`Set ${name}.`);
    process.exit(1);
  }
  return value;
};

const application = required("DISCORD_APPLICATION_ID");
const token = required("DISCORD_BOT_TOKEN");
const guild = process.env.DISCORD_GUILD_ID ?? "";

if (!/^\d{1,20}$/u.test(application) || !/^\d{0,20}$/u.test(guild)) {
  console.error("DISCORD_APPLICATION_ID and DISCORD_GUILD_ID are Discord ids.");
  process.exit(1);
}

const url =
  guild === ""
    ? `${api}/applications/${application}/commands`
    : `${api}/applications/${application}/guilds/${guild}/commands`;

const response = await fetch(url, {
  method: "PUT",
  headers: {
    authorization: `Bot ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(discordCommands),
});

if (!response.ok) {
  console.error(
    `Discord refused the commands: ${response.status} ${await response.text()}`
  );
  process.exit(1);
}

console.info(
  `Registered /${discordCommands.map((command) => command.name).join(", /")} ${guild === "" ? "globally" : `in server ${guild}`}.`
);
