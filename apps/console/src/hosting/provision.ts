/**
 * Ensures a placed client's private databases and buckets exist in its
 * destination (spec 40.2, step 2): each under the name its inventory
 * records, in the jurisdiction the inventory records, with the provider's
 * id persisted before the next one.
 *
 * The runner that holds the client does it, one resource at a time, and
 * can be stopped anywhere and run again: what it observed is recorded,
 * so a retry skips it. Before each create it records that it asked
 * (`createRequestedBy`), in a write only a runner still holding the
 * client can make. A resource found under its recorded name is adopted
 * only after such a request, as one whose create answer was lost; one
 * nobody asked for is someone else's, and stops the run rather than be
 * adopted because its name matches (spec 39.2). Nothing here deletes.
 */
import { and, eq, isNull } from "drizzle-orm";

import {
  createD1Database,
  createR2Bucket,
  findD1Database,
  findR2Bucket,
} from "../cloudflare/accounts.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { actIfChanged } from "../db/act.ts";
import type { Actor, ConsoleDatabase } from "../db/act.ts";
import { clientResources } from "../db/schema.ts";
import { holdsClient, stillHolds } from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import {
  assertPlaceable,
  clientInventory,
  destinationOf,
  InventoryError,
  placementOf,
  recordProviderId,
} from "./inventory.ts";
import type { ClientResource } from "./inventory.ts";
import { hostingPolicyIdSchema } from "./policy.ts";

/** What the provider reports of a database or bucket. */
interface Observed {
  /** The id a binding takes: a D1 database's uuid, a bucket's name. */
  id: string;
  jurisdiction: string | null | undefined;
}

/** How each kind of resource is found and created at the provider. */
interface Provider {
  find: (resource: ClientResource) => Promise<Observed | undefined>;
  create: (resource: ClientResource) => Promise<Observed>;
}

const providerFor = (
  api: CloudflareApi,
  accountId: string,
  kind: ClientResource["kind"]
): Provider | undefined => {
  if (kind === "d1_database") {
    return {
      find: async ({ physicalName }) => {
        const found = await findD1Database(api, accountId, physicalName);
        return found && { id: found.uuid, jurisdiction: found.jurisdiction };
      },
      create: async ({ physicalName, jurisdiction }) => {
        const made = await createD1Database(
          api,
          accountId,
          physicalName,
          jurisdiction
        );
        return { id: made.uuid, jurisdiction: made.jurisdiction };
      },
    };
  }
  if (kind === "r2_bucket") {
    return {
      find: async ({ physicalName, jurisdiction }) => {
        const found = await findR2Bucket(
          api,
          accountId,
          physicalName,
          jurisdiction
        );
        return found && { id: found.name, jurisdiction: found.jurisdiction };
      },
      create: async ({ physicalName, jurisdiction }) => {
        const made = await createR2Bucket(
          api,
          accountId,
          physicalName,
          jurisdiction
        );
        return { id: made.name, jurisdiction: made.jurisdiction };
      },
    };
  }
  // Scripts and Durable Object classes are made by the upload (step 3).
  return undefined;
};

const replaced = (held: HeldClient) =>
  new InventoryError(
    "runner_replaced",
    `${held.runId} no longer holds ${held.clientId}`
  );

/**
 * Records that runner `held` asks the provider to create `resource`, if
 * it still holds the client and the resource isn't observed yet.
 */
const requestCreate = async (
  db: ConsoleDatabase,
  actor: Actor,
  held: HeldClient,
  resource: ClientResource
): Promise<void> => {
  const requested = await actIfChanged(
    db,
    actor,
    db
      .update(clientResources)
      .set({ createRequestedBy: held.runId, updatedAt: new Date() })
      .where(
        and(
          eq(clientResources.clientId, held.clientId),
          eq(clientResources.role, resource.role),
          isNull(clientResources.providerId),
          stillHolds(held)
        )
      ),
    {
      action: "client.resource_create",
      clientId: held.clientId,
      target: resource.role,
      detail: { run: held.runId },
    }
  );
  if (!requested) {
    throw (await holdsClient(db, held.clientId, held.runId))
      ? new InventoryError(
          "resource_conflict",
          `${held.clientId}'s ${resource.role} was observed by another run`
        )
      : replaced(held);
  }
};

/**
 * Ensures every allocated database and bucket in client `held.clientId`'s
 * inventory exists in its destination and records what the provider
 * reports, as runner `held`, which must hold the client. Returns the
 * inventory with every one of them observed.
 */
export const ensureClientResources = async (
  api: CloudflareApi,
  db: ConsoleDatabase,
  actor: Actor,
  held: HeldClient
): Promise<ClientResource[]> => {
  const { clientId } = held;
  if (!(await holdsClient(db, clientId, held.runId))) {
    throw replaced(held);
  }
  const placement = await placementOf(db, clientId);
  if (placement === undefined) {
    throw new InventoryError("not_placed", `${clientId} isn't placed`);
  }
  await assertPlaceable(
    db,
    placement.destinationId,
    hostingPolicyIdSchema.parse(placement.policyId)
  );
  const destination = await destinationOf(db, placement.destinationId);
  if (destination.kind === "workerd" || destination.accountId === null) {
    throw new InventoryError(
      "destination_unsupported",
      `${destination.id} has no Cloudflare account to create resources in`
    );
  }
  const { accountId } = destination;

  for (const resource of await clientInventory(db, clientId)) {
    const provider = providerFor(api, accountId, resource.kind);
    if (
      provider === undefined ||
      resource.lifecycle !== "allocated" ||
      resource.providerId !== null
    ) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
    let observed = await provider.find(resource);
    if (observed !== undefined && resource.createRequestedBy === null) {
      throw new InventoryError(
        "unowned_resource",
        `${resource.physicalName} exists in ${destination.id}, but ${clientId} never asked for it`
      );
    }
    if (observed === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
      await requestCreate(db, actor, held, resource);
      // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
      observed = await provider.create(resource);
    }
    // Whichever call answered, only what the provider reports in the
    // recorded jurisdiction is used: one set at creation isn't relabelled.
    if (observed.jurisdiction !== resource.jurisdiction) {
      throw new InventoryError(
        "resource_outside_jurisdiction",
        `${resource.physicalName} is in ${observed.jurisdiction ?? "no jurisdiction"}, not ${resource.jurisdiction}`
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- persisted before the next
    await recordProviderId(
      db,
      actor,
      {
        clientId,
        role: resource.role,
        physicalName: resource.physicalName,
        providerId: observed.id,
      },
      held
    );
  }
  return await clientInventory(db, clientId);
};
