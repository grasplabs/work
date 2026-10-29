/**
 * A client's hosting's server functions, behind the Access check every
 * request passes (src/access.ts). Placing and provisioning acts as the
 * verified staff member the request comes from, and answers a refusal as
 * its code (`PlaceRefusal`), which the page words; anything else fails.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import { ProvisionError } from "../provision/errors.ts";
import { DiscardError, discardClient } from "./discard.ts";
import type { DiscardErrorCode } from "./discard.ts";
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
import { resumeProvisioning } from "./reconcile.ts";
import { releasePlacedClient } from "./workflow.ts";

/** What placing and provisioning answers: the attempt it started, or why it was refused. */
export type PlaceResult =
  | { runId: string; refused: null }
  | { runId: null; refused: PlaceRefusal };

/** `error` as a refusal, or null for anything that isn't one. */
const refusalOf = (error: unknown): PlaceResult | null => {
  if (
    error instanceof InventoryError ||
    error instanceof PlacementError ||
    error instanceof ProvisionOperationError
  ) {
    return { runId: null, refused: error.code };
  }
  if (
    error instanceof ProvisionError &&
    (error.code === "already_running" || error.code === "not_provisioning")
  ) {
    return { runId: null, refused: error.code };
  }
  return null;
};

export const fetchClientHosting = createServerFn({ method: "GET" })
  .validator(z.object({ clientId: z.string().min(1) }))
  .handler(async ({ data }) => await getClientHosting(env, data.clientId));

/** Runs `start`, which answers the attempt it started, a refusal as its code. */
const attempt = async (start: () => Promise<string>): Promise<PlaceResult> => {
  try {
    return { runId: await start(), refused: null };
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
      };
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) {
        throw error;
      }
      return refusal;
    }
  });

/**
 * Setup's "Retry now": resumes the client's provisioning as the signed-in
 * staff member, as the reconciler would (`resumeProvisioning`), at once
 * and starting its episode afresh, so its automatic retries count again.
 */
export const retryProvisioningFn = createServerFn({ method: "POST" })
  .validator(z.object({ clientId: z.string().min(1) }))
  .handler(
    async ({ data, context }): Promise<PlaceResult> =>
      await attempt(
        async () => await resumeProvisioning(env, context.staff, data.clientId)
      )
  );

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

/** What discarding answers: done, or why it was refused. */
export interface DiscardResult {
  refused: DiscardErrorCode | null;
}

/**
 * Discarding a client that was never placed and has nothing anywhere
 * (src/hosting/discard.ts): its record goes, audited, and its id is free.
 */
export const discardClientFn = createServerFn({ method: "POST" })
  .validator(z.object({ clientId: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<DiscardResult> => {
    try {
      await discardClient(env, context.staff, data.clientId);
      return { refused: null };
    } catch (error) {
      if (error instanceof DiscardError) {
        return { refused: error.code };
      }
      throw error;
    }
  });

/** Every offboarded placed client, for Platform's Offboarded page. */
export const fetchOffboardedClients = createServerFn({ method: "GET" }).handler(
  async () => await offboardedClients(adminDatabase(env.DB))
);
