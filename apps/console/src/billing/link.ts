/**
 * Which customer in Grasp's Stripe a client is, as someone at Grasp says
 * by hand: its id (`cus_...`), as Stripe shows it. The console never
 * matches one by name or billing email, which two companies can share or
 * a typo can hand to the wrong one; a person who has both in front of
 * them links them. Audited (`client.stripe_customer`, the customer's id as
 * its target, none when unlinked) in the same batch as the change, and
 * only when it changes something.
 */
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, consoleDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";

/** A Stripe customer's id, as Stripe makes them. */
export const stripeCustomerIdPattern = /^cus_[A-Za-z0-9]{1,250}$/u;

/** Why linking was refused, as the page words it. */
export type StripeLinkErrorCode = "unknown_client" | "customer_id_invalid";

export class StripeLinkError extends Error {
  readonly code: StripeLinkErrorCode;

  constructor(code: StripeLinkErrorCode, message: string) {
    super(message);
    this.name = "StripeLinkError";
    this.code = code;
  }
}

/**
 * A link as the page sends it: the customer's id, or null to unlink.
 * The id is checked here, not by the server function's validator, so a
 * refusal comes back as its code.
 */
export const stripeLinkInputSchema = z.object({
  clientId: z.string().min(1),
  customerId: z.string().nullable(),
});

/**
 * Links client `clientId` to Stripe customer `customerId`, or unlinks it
 * for null, as `staff`. Returns whether it changed.
 */
export const setStripeCustomer = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof stripeLinkInputSchema>
): Promise<boolean> => {
  const { clientId, customerId: given } = stripeLinkInputSchema.parse(input);
  const customerId = given === null ? null : given.trim();
  if (customerId !== null && !stripeCustomerIdPattern.test(customerId)) {
    throw new StripeLinkError(
      "customer_id_invalid",
      `Not a Stripe customer id for ${clientId}`
    );
  }
  const db = consoleDatabase(env.DB);
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    throw new StripeLinkError("unknown_client", `No client ${clientId}`);
  }
  const differs =
    customerId === null
      ? isNotNull(clients.stripeCustomerId)
      : or(
          isNull(clients.stripeCustomerId),
          ne(clients.stripeCustomerId, customerId)
        );
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), differs)),
    {
      action: "client.stripe_customer",
      clientId,
      ...(customerId === null ? {} : { target: customerId }),
    }
  );
};
