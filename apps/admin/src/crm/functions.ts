/**
 * Linking an organization to its company in Grasp's Attio, as the admin's
 * Details does it, behind the Access check every request passes
 * (src/access.ts), as the verified staff member the request comes from.
 * A refusal is answered as its code, which the page words.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

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
