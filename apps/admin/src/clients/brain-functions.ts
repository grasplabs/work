/**
 * A client's Brain, as an organization's Brain section reads it and acts
 * on it, behind the Access check every request passes (src/access.ts), as
 * the verified staff member the request comes from (src/clients/brain.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import {
  actOnBrain,
  brainActionInputSchema,
  brainErasureInputSchema,
  lookUpBrainErasure,
  readBrainReport,
} from "./brain.ts";
import type { BrainActionResult, BrainErasureResult } from "./brain.ts";

export const fetchBrainReport = createServerFn({ method: "GET" })
  .validator(z.object({ clientId: z.string().min(1).max(63) }))
  .handler(
    async ({ data, context }) =>
      await readBrainReport(env, context.staff, data.clientId)
  );

export const brainActionFn = createServerFn({ method: "POST" })
  .validator(brainActionInputSchema)
  .handler(
    async ({ data, context }): Promise<BrainActionResult> =>
      await actOnBrain(env, context.staff, data)
  );

export const brainErasureFn = createServerFn({ method: "POST" })
  .validator(brainErasureInputSchema)
  .handler(
    async ({ data, context }): Promise<BrainErasureResult> =>
      await lookUpBrainErasure(env, context.staff, data)
  );
