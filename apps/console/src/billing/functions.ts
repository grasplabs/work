/**
 * Linking an organization to its customer in Grasp's Stripe, as the
 * admin's Billing does it, behind the Access check every request passes
 * (src/access.ts), as the verified staff member the request comes from.
 * A refusal is answered as its code, which the page words.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import {
  setStripeCustomer,
  StripeLinkError,
  stripeLinkInputSchema,
} from "./link.ts";
import type { StripeLinkErrorCode } from "./link.ts";

/** What linking answers: whether it changed anything, or why it was refused. */
export type StripeLinkChange =
  | { changed: boolean; refused: null }
  | { changed: null; refused: StripeLinkErrorCode };

export const setStripeCustomerFn = createServerFn({ method: "POST" })
  .validator(stripeLinkInputSchema)
  .handler(async ({ data, context }): Promise<StripeLinkChange> => {
    try {
      return {
        changed: await setStripeCustomer(env, context.staff, data),
        refused: null,
      };
    } catch (error) {
      if (error instanceof StripeLinkError) {
        return { changed: null, refused: error.code };
      }
      throw error;
    }
  });
