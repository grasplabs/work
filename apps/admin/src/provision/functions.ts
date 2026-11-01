/**
 * Adding a client's server functions, behind the Access check every
 * request passes (src/access.ts). Adding one acts as the verified staff
 * member the request comes from, and answers a refusal as its code
 * (`ProvisionErrorCode`), which the page words; anything else fails.
 */
import { log } from "@grasp-os/shared/log";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import { clientDomain } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { provisionIfReady } from "../hosting/placement.ts";
import { listReleases } from "../releases/queries.ts";
import {
  clientIdAvailability,
  createClient,
  provisionInputSchema,
} from "./control.ts";
import { ProvisionError } from "./errors.ts";
import type { ProvisionErrorCode } from "./errors.ts";
import { detectSignIn } from "./sign-in-detect.ts";
import type { DetectedSignIn } from "./sign-in-detect.ts";

/** What adding a client answers: the client, or why it was refused. */
export type ChangeResult =
  | { clientId: string; refused: null }
  | { clientId: null; refused: ProvisionErrorCode };

/** The imported releases, newest first: what a client's provisioning picks from. */
export const fetchNewClientOptions = createServerFn({ method: "GET" }).handler(
  async () => {
    const { releases } = await listReleases(adminDatabase(env.DB));
    return {
      releases: releases.map(({ id, notes, versionMajor, versionMinor }) => ({
        id,
        notes,
        versionMajor,
        versionMinor,
      })),
    };
  }
);

/**
 * What the create page needs before anything is typed: the domain every
 * organization's web address ends in, `<id>.<domain>`; null while the
 * admin has none.
 */
export const fetchCreateOptions = createServerFn({ method: "GET" }).handler(
  () => ({ clientDomain: clientDomain(env) })
);

/** Whether a web address can be a new organization's: why not, or null. */
export const checkClientIdFn = createServerFn({ method: "GET" })
  .validator(z.object({ clientId: z.string().max(100) }))
  .handler(
    async ({ data }) =>
      await clientIdAvailability(adminDatabase(env.DB), data.clientId)
  );

/** How a company's people sign in, found from its email domain (`detectSignIn`). */
export const detectSignInFn = createServerFn({ method: "GET" })
  .validator(z.object({ domain: z.string().max(253) }))
  .handler(
    async ({ data }): Promise<DetectedSignIn> => await detectSignIn(data.domain)
  );

/**
 * Adds a client, then starts its provisioning at once when nothing keeps
 * it (`provisionIfReady`): its Setup then shows it going, or exactly why
 * it hasn't started.
 */
export const startClient = createServerFn({ method: "POST" })
  .validator(provisionInputSchema)
  .handler(async ({ data, context }): Promise<ChangeResult> => {
    let clientId: string;
    try {
      clientId = await createClient(env, context.staff, data);
    } catch (error) {
      if (error instanceof ProvisionError) {
        return { clientId: null, refused: error.code };
      }
      throw error;
    }
    try {
      await provisionIfReady(env, context.staff, clientId);
    } catch (error) {
      // Added all the same: its Setup says it hasn't started, and why.
      log.error("client.provision_not_started", {
        clientId,
        error: errorCode(error),
      });
    }
    return { clientId, refused: null };
  });
