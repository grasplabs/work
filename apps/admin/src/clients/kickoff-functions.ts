/**
 * The kickoff, as an organization's Steps ask for it, behind the Access
 * check every request passes (src/access.ts), as the verified staff
 * member the request comes from (src/clients/kickoff.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { askKickoff, kickoffInputSchema } from "./kickoff.ts";
import type { KickoffAnswer } from "./kickoff.ts";
import { forgetSummary } from "./summary.ts";

/**
 * Asks the kickoff; then the client's kept summary is forgotten, whatever
 * came of it, so the frame's read after it counts what it changed.
 */
export const kickoffFn = createServerFn({ method: "POST" })
  .validator(kickoffInputSchema)
  .handler(async ({ data, context }): Promise<KickoffAnswer> => {
    try {
      return await askKickoff(env, context.staff, data);
    } finally {
      await forgetSummary(data.clientId);
    }
  });
