/**
 * Linking an organization to its company in Grasp's Attio, as the admin's
 * Details does it, and the won deals a new organization can start from,
 * behind the Access check every request passes
 * (src/access.ts), as the verified staff member the request comes from.
 * A refusal is answered as its code, which the page words.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { healthTimeoutMs } from "../clients/grid.ts";
import { wonDealsOf } from "./crm.ts";
import type { WonDeals } from "./crm.ts";
import {
  AttioLinkError,
  attioLinkInputSchema,
  setAttioCompany,
} from "./link.ts";
import type { AttioLinkErrorCode } from "./link.ts";

/** What linking answers: whether it changed anything, or why it was refused. */
export type AttioLinkChange =
  | { changed: boolean; refused: null }
  | { changed: null; refused: AttioLinkErrorCode };

export const setAttioCompanyFn = createServerFn({ method: "POST" })
  .validator(attioLinkInputSchema)
  .handler(async ({ data, context }): Promise<AttioLinkChange> => {
    try {
      return {
        changed: await setAttioCompany(env, context.staff, data),
        refused: null,
      };
    } catch (error) {
      if (error instanceof AttioLinkError) {
        return { changed: null, refused: error.code };
      }
      throw error;
    }
  });

/** The deals Grasp won in Attio that no organization is linked to yet, to start one from. */
export const fetchWonDeals = createServerFn({ method: "GET" }).handler(
  async (): Promise<WonDeals> => await wonDealsOf(env, healthTimeoutMs)
);
