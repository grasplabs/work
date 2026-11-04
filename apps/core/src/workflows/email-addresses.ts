import { toHex } from "@grasp-os/shared/encoding";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { triggerResources } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";

// The addresses workflows receive mail at, on the deployment's mail
// domain (inbound-email.ts): an independent workflow's email trigger has
// the name its builder chose, or one of its own, `trigger-` and 128
// random bits (trigger-resources.ts). Each name follows one rule
// (`emailLocalPartSchema`). A random one is no other's unless copied, and
// a copy is refused as taken.
//
// An address is one trigger's: the first to take it keeps it, so nobody
// reads mail meant for another. A trigger holds its address while it
// lives, disabled or not, and gives it up as it is deleted. Whoever takes
// an address checks it is free twice: first, to answer
// `workflow.email_taken`, and again in the very statement that takes it
// (`addressTaken`), so two taking it at once never both land.

/** Random bytes in an email trigger's address: 128 bits. */
const randomAddressBytes = 16;

/** A new address of its own, for an email trigger whose builder named none. */
export const randomEmailAddress = (): string =>
  `trigger-${toHex(crypto.getRandomValues(new Uint8Array(randomAddressBytes)))}`;

/** Which of `addresses` a live email trigger holds, as a query. */
const holders = (addresses: readonly string[]): SQL => sql`
  SELECT ${triggerResources.emailAddress} AS address FROM ${triggerResources}
  WHERE ${triggerResources.deletedAt} IS NULL
    AND ${inList(triggerResources.emailAddress, addresses)}`;

/**
 * Whether a trigger holds one of `addresses`, as SQL for the statement
 * that takes them.
 */
export const addressTaken = (addresses: readonly string[]): SQL =>
  sql`EXISTS (${holders(addresses)})`;

/** Refuses `addresses` when a trigger holds one (`workflow.email_taken`). */
export const requireFreeAddresses = async (
  env: Env,
  addresses: readonly string[]
): Promise<void> => {
  if (addresses.length === 0) {
    return;
  }
  const taken = await drizzle(env.DB).get<{ address: string } | undefined>(
    sql`${holders(addresses)} LIMIT 1`
  );
  if (taken !== undefined) {
    throw workflowErrors.create("workflow.email_taken", {
      address: taken.address,
    });
  }
};
