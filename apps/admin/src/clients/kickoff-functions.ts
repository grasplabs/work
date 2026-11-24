/**
 * The kickoff, as an organization's Steps ask for it, behind the Access
 * check every request passes (src/access.ts), as the verified staff
 * member the request comes from (src/clients/kickoff.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { askKickoff, kickoffInputSchema } from "./kickoff.ts";
import type { KickoffAnswer } from "./kickoff.ts";

export const kickoffFn = createServerFn({ method: "POST" })
  .validator(kickoffInputSchema)
  .handler(
    async ({ data, context }): Promise<KickoffAnswer> =>
      await askKickoff(env, context.staff, data)
  );
