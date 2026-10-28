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

import { adminDatabase } from "../db/act.ts";
import { ProvisionError } from "../provision/errors.ts";
import { InventoryError } from "./inventory.ts";
import {
  deletePlacedClient,
  offboardedClients,
  OffboardingError,
  offboardPlacedClient,
} from "./offboarding.ts";
import type { Deletion, OffboardingErrorCode } from "./offboarding.ts";
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
import { releasePlacedClient } from "./workflow.ts";

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

/** Runs `start`, which answers the attempt it started, a refusal as its code. */
const attempt = async (start: () => Promise<string>): Promise<PlaceResult> => {
  try {
    return { runId: await start(), refused: null, problems: [] };
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === null) {
      throw error;
    }
    return refusal;
  }
};

/** Releasing a live placed client to `releaseId`, or resuming that release. */
export const releasePlacedClientFn = createServerFn({ method: "POST" })
  .validator(
    z.object({ clientId: z.string().min(1), releaseId: z.string().min(1) })
  )
  .handler(
    async ({ data, context }): Promise<PlaceResult> =>
      await attempt(
        async () =>
          await releasePlacedClient(env, context.staff, data.clientId, {
            releaseId: data.releaseId,
          })
      )
  );

/** Rolling a live placed client back to the release it ran before. */
export const rollbackPlacedClientFn = createServerFn({ method: "POST" })
  .validator(z.object({ clientId: z.string().min(1) }))
  .handler(
    async ({ data, context }): Promise<PlaceResult> =>
      await attempt(
        async () =>
          await releasePlacedClient(env, context.staff, data.clientId, {
            rollback: true,
          })
      )
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

/** What offboarding or deleting answers: what it did, or why it was refused. */
export type OffboardResult =
  | { refused: null; deletion: Deletion | null }
  | { refused: OffboardingErrorCode; deletion: null };

/** Runs `task`, a refusal as its code. */
const offboarding = async (
  task: () => Promise<Deletion | null>
): Promise<OffboardResult> => {
  try {
    return { refused: null, deletion: await task() };
  } catch (error) {
    if (error instanceof OffboardingError) {
      return { refused: error.code, deletion: null };
    }
    throw error;
  }
};

/** Offboarding a placed client: unrouted at once, nothing deleted. */
export const offboardPlacedClientFn = createServerFn({ method: "POST" })
  .validator(z.object({ clientId: z.string().min(1) }))
  .handler(
    async ({ data, context }): Promise<OffboardResult> =>
      await offboarding(async () => {
        await offboardPlacedClient(env, context.staff, data.clientId);
        return null;
      })
  );

/** Deleting an offboarded placed client's resources, once its retention is over. */
export const deletePlacedClientFn = createServerFn({ method: "POST" })
  .validator(
    z.object({ clientId: z.string().min(1), exportConfirmed: z.boolean() })
  )
  .handler(
    async ({ data, context }): Promise<OffboardResult> =>
      await offboarding(
        async () =>
          await deletePlacedClient(env, context.staff, data.clientId, {
            exportConfirmed: data.exportConfirmed,
          })
      )
  );

/** Every offboarded placed client, for Platform's Offboarded page. */
export const fetchOffboardedClients = createServerFn({ method: "GET" }).handler(
  async () => await offboardedClients(adminDatabase(env.DB))
);
