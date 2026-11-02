/**
 * Commands to a client's onboarding, as an organization's pages give
 * them, behind the Access check every request passes (src/access.ts), as
 * the verified staff member the request comes from (src/clients/commands.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { commandInputSchema, giveCommand } from "./commands.ts";
import type { CommandAnswer } from "./commands.ts";

export const commandFn = createServerFn({ method: "POST" })
  .validator(commandInputSchema)
  .handler(
    async ({ data, context }): Promise<CommandAnswer> =>
      await giveCommand(env, context.staff, data)
  );
