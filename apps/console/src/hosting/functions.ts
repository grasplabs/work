/**
 * A client's hosting's server functions, behind the Access check every
 * request passes (src/access.ts). Placing and provisioning acts as the
 * verified staff member the request comes from, and answers a refusal as
 * its code (`PlaceRefusal`), with the requirements a destination misses,
 * which the page words; anything else fails.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { ProvisionError } from "../provision/control.ts";
import { InventoryError } from "./inventory.ts";
import { ProvisionOperationError } from "./operation.ts";
import {
  getClientHosting,
  PlacementError,
  placeAndProvision,
  placeInputSchema,
} from "./placement.ts";
import type { PlaceRefusal } from "./placement.ts";
import { hostingPolicyIdSchema } from "./policy.ts";
import type { PlacementProblem } from "./policy.ts";

/** What placing and provisioning answers: the attempt it started, or why it was refused. */
export type PlaceResult =
  | { runId: string; refused: null; problems: [] }
  | { runId: null; refused: PlaceRefusal; problems: PlacementProblem[] };

/** `error` as a refusal, or null for anything that isn't one. */
const refusalOf = (error: unknown): PlaceResult | null => {
  if (error instanceof InventoryError) {
    return { runId: null, refused: error.code, problems: [...error.problems] };
  }
  if (
    error instanceof PlacementError ||
    error instanceof ProvisionOperationError
  ) {
    return { runId: null, refused: error.code, problems: [] };
  }
  if (
    error instanceof ProvisionError &&
    (error.code === "already_running" || error.code === "not_provisioning")
  ) {
    return { runId: null, refused: error.code, problems: [] };
  }
  return null;
};

export const fetchClientHosting = createServerFn({ method: "GET" })
  .validator(
    z.object({ clientId: z.string().min(1), policyId: hostingPolicyIdSchema })
  )
  .handler(
    async ({ data }) =>
      await getClientHosting(env, data.clientId, data.policyId)
  );

export const placeAndProvisionFn = createServerFn({ method: "POST" })
  .validator(placeInputSchema)
  .handler(async ({ data, context }): Promise<PlaceResult> => {
    try {
      return {
        runId: await placeAndProvision(env, context.staff, data),
        refused: null,
        problems: [],
      };
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) {
        throw error;
      }
      return refusal;
    }
  });
