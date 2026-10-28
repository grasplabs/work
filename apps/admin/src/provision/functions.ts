/**
 * Adding a client's server functions, behind the Access check every
 * request passes (src/access.ts). Adding one acts as the verified staff
 * member the request comes from, and answers a refusal as its code
 * (`ProvisionErrorCode`), which the page words; anything else fails.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { adminDatabase } from "../db/act.ts";
import { listReleases } from "../releases/queries.ts";
import { createClient, provisionInputSchema } from "./control.ts";
import { ProvisionError } from "./errors.ts";
import type { ProvisionErrorCode } from "./errors.ts";

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

export const startClient = createServerFn({ method: "POST" })
  .validator(provisionInputSchema)
  .handler(async ({ data, context }): Promise<ChangeResult> => {
    try {
      return {
        clientId: await createClient(env, context.staff, data),
        refused: null,
      };
    } catch (error) {
      if (error instanceof ProvisionError) {
        return { clientId: null, refused: error.code };
      }
      throw error;
    }
  });
