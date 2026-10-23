/**
 * The `/grasp` slash command Grasp's Discord bot answers (src/admin/discord.ts),
 * as Discord registers it: one command with a subcommand for each question,
 * each mapped to one of the admin's read-only tools. Registered once per
 * Discord application with `vp run discord:commands` (scripts/discord-commands.ts),
 * which reads this file, so the bot and what Discord offers can't disagree.
 * Data only: Node reads it as well as workerd.
 */
import { ADMIN_PHASES } from "@grasp-os/shared/admin/admin-health";

/** Discord's option types (application command option type). */
const SUB_COMMAND = 1;
const STRING = 3;

/** Discord's command type for a slash command (CHAT_INPUT). */
const CHAT_INPUT = 1;

/** The command's name: `/grasp`. */
export const discordCommandName = "grasp";

/** The subcommands, by name. */
export const discordSubcommands = {
  orgs: "orgs",
  org: "org",
  needs: "needs",
} as const;

/** The `/grasp` command as Discord's API takes it. */
export const discordCommands = [
  {
    name: discordCommandName,
    type: CHAT_INPUT,
    description: "Ask Grasp's admin about the companies (staff only).",
    // Not offered in DMs: only in Grasp's own server.
    contexts: [0],
    options: [
      {
        type: SUB_COMMAND,
        name: discordSubcommands.orgs,
        description:
          "Every company: its phase, how much is known, and what needs Grasp.",
        options: [
          {
            type: STRING,
            name: "phase",
            description: "Only the companies in this phase.",
            required: false,
            choices: ADMIN_PHASES.map((phase) => ({
              name: phase,
              value: phase,
            })),
          },
        ],
      },
      {
        type: SUB_COMMAND,
        name: discordSubcommands.org,
        description: "One company: where it stands and what needs Grasp there.",
        options: [
          {
            type: STRING,
            name: "name",
            description: "The company, by its id or its name (a part will do).",
            required: true,
            max_length: 100,
          },
        ],
      },
      {
        type: SUB_COMMAND,
        name: discordSubcommands.needs,
        description:
          "Everything that waits for a person at Grasp, most pressing first.",
      },
    ],
  },
] as const;
