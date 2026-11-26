/**
 * Commands to a client's onboarding, as an organization's pages give
 * them, behind the Access check every request passes (src/access.ts), as
 * the verified staff member the request comes from (src/clients/commands.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { commandInputSchema, giveCommand } from "./commands.ts";
import type { GivenAnswer } from "./commands.ts";
import { forgetSummary } from "./summary.ts";

/**
 * Gives the command; then the client's kept summary is forgotten, whatever
 * came of it (one that failed may still have applied), so the frame's
 * read after it counts what it changed.
 */
export const commandFn = createServerFn({ method: "POST" })
  .validator(commandInputSchema)
  .handler(async ({ data, context }): Promise<GivenAnswer> => {
    try {
      return await giveCommand(env, context.staff, data);
    } finally {
      await forgetSummary(data.clientId);
    }
  });
