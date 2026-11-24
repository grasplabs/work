/**
 * Ask Grasp's question, as the admin's chat sends it, behind the Access
 * check every request passes (src/access.ts), as the verified staff
 * member the request comes from (src/admin/ask.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { askGrasp, askInputSchema } from "./ask.ts";
import type { AskAnswer } from "./ask.ts";

export const askGraspFn = createServerFn({ method: "POST" })
  .validator(askInputSchema)
  .handler(
    async ({ data, context }): Promise<AskAnswer> =>
      await askGrasp(env, context.staff, data)
  );
