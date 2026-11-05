import { toHex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { apps, triggerResources, workflowTriggers } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { replyLocalPattern } from "./run-inboxes.ts";

// The addresses workflows receive mail at, on the deployment's mail
// domain (inbound-email.ts): one namespace, whoever receives there. An
// App's current version names its addresses in its workflows' triggers
// (trigger-registry.ts); an independent workflow's email trigger has the
// name its builder chose, or one of its own, `trigger-` and 128 random
// bits (trigger-resources.ts). Each name follows one rule
// (`emailLocalPartSchema`). A random one is no other's unless copied, and
// a copy is refused as taken.
//
// An address is one workflow's: the first to take it keeps it, so nobody
// reads mail meant for another. An App's current version holds its
// addresses until a version without them is made current; a trigger holds
// its address while it lives, disabled or not, and gives it up as it is
// deleted. Whoever takes an address checks it is free twice: first, to
// answer `workflow.email_taken`, and again in the very statement that
// takes it (`addressTaken`), so two taking it at once never both land.

/** Random bytes in an email trigger's address: 128 bits. */
const randomAddressBytes = 16;

/** A new address of its own, for an email trigger whose builder named none. */
export const randomEmailAddress = (): string =>
  `trigger-${toHex(crypto.getRandomValues(new Uint8Array(randomAddressBytes)))}`;

/**
 * Which of `addresses` someone holds, as a query: an App's current
 * version (but App `except`'s, whose next version takes its own over), or
 * a live email trigger.
 */
const holders = (addresses: readonly string[], except?: AppId): SQL => sql`
  SELECT ${workflowTriggers.address} AS address FROM ${workflowTriggers}
  JOIN ${apps} ON ${apps.id} = ${workflowTriggers.appId}
    AND ${apps.currentVersion} = ${workflowTriggers.version}
  WHERE ${workflowTriggers.type} = 'email'
    ${except === undefined ? sql`` : sql`AND ${workflowTriggers.appId} <> ${except}`}
    AND ${inList(workflowTriggers.address, addresses)}
  UNION ALL
  SELECT ${triggerResources.emailAddress} AS address FROM ${triggerResources}
  WHERE ${triggerResources.deletedAt} IS NULL
    AND ${inList(triggerResources.emailAddress, addresses)}`;

/**
 * Whether someone other than App `except` holds one of `addresses`, as SQL
 * for the statement that takes them.
 */
export const addressTaken = (
  addresses: readonly string[],
  except?: AppId
): SQL => sql`EXISTS (${holders(addresses, except)})`;

/**
 * Refuses `addresses` when someone other than App `except` holds one, or
 * one has the shape of a run's reply address (`replyLocalPattern`,
 * run-inboxes.ts), which no workflow takes: a builder who saw one in a
 * run's trace would otherwise read its replies (`workflow.email_taken`).
 */
export const requireFreeAddresses = async (
  env: Env,
  addresses: readonly string[],
  except?: AppId
): Promise<void> => {
  const reserved = addresses.find((address) => replyLocalPattern.test(address));
  if (reserved !== undefined) {
    throw workflowErrors.create("workflow.email_taken", { address: reserved });
  }
  if (addresses.length === 0) {
    return;
  }
  const taken = await drizzle(env.DB).get<{ address: string } | undefined>(
    sql`${holders(addresses, except)} LIMIT 1`
  );
  if (taken !== undefined) {
    throw workflowErrors.create("workflow.email_taken", {
      address: taken.address,
    });
  }
};
