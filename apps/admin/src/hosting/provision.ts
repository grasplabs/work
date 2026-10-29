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
 *
 * In a destination that checks itself (`checksItself`), what it reads
 * back is also the destination's evidence (`selfCheckedCapabilities`):
 * each kind it observed in the policy's jurisdiction is recorded as
 * verified by the system, the first time, and one it observed outside it
 * as unsupported, which stops this run and keeps every later placement
 * out of the destination.
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
import type { Actor, AdminDatabase } from "../db/act.ts";
import { clientResources } from "../db/schema.ts";
import { holdsClient, stillHolds } from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import {
  assertPlaceable,
  checksItself,
  clientInventory,
  destinationOf,
  InventoryError,
  placementOf,
  recordCapabilityEvidence,
  recordProviderId,
} from "./inventory.ts";
import type { ClientResource } from "./inventory.ts";
import { hostingPolicyIdSchema } from "./policy.ts";
import type { Capability, DestinationCapabilities } from "./policy.ts";

/** What provisioning's own check is recorded against: the release it runs, and where to read about the run. */
export interface SelfCheck {
  releaseId: string;
  /** The run that observed it. */
  runId: string;
  /** A page in the admin where the run's client and its operation are. */
  record: string;
}

/** The capability a kind of resource's jurisdiction shows. */
const capabilityOf: Partial<Record<ClientResource["kind"], Capability>> = {
  d1_database: "d1.eu_jurisdiction",
  r2_bucket: "r2.eu_jurisdiction",
};

/** Provisioning's observations of `observed`, each `status`, as evidence. */
const observations = (
  check: SelfCheck,
  observed: readonly Capability[],
  status: "verified" | "unsupported"
): DestinationCapabilities =>
  Object.fromEntries(
    observed.map((capability) => [
      capability,
      {
        status,
        evidence: {
          procedure: `Automatic check during provisioning, run ${check.runId}: read back from Cloudflare the jurisdiction of each ${capability.startsWith("d1") ? "D1 database" : "R2 bucket"} it created or found for the client.`,
          subject: { kind: "release", id: check.releaseId },
          observedAt: new Date().toISOString(),
          recordedBy: "system",
          record: check.record,
        },
      },
    ])
  );

/**
 * Records, in a destination that checks itself, that the resource just
 * read back shows `capability` unsupported, then throws: the run stops
 * there, and the destination takes no one until a person looks.
 */
const refuseOutside = async (
  db: AdminDatabase,
  destinationId: string,
  check: SelfCheck | undefined,
  resource: ClientResource,
  jurisdiction: string | null | undefined
): Promise<never> => {
  const capability = capabilityOf[resource.kind];
  if (check !== undefined && capability !== undefined) {
    await recordCapabilityEvidence(
      db,
      "system",
      destinationId,
      observations(check, [capability], "unsupported")
    );
  }
  throw new InventoryError(
    "resource_outside_jurisdiction",
    `${resource.physicalName} is in ${jurisdiction ?? "no jurisdiction"}, not ${resource.jurisdiction}`,
    capability === undefined
      ? []
      : [{ kind: "capability_unsupported", capability }]
  );
};

/**
 * Judges what the provider reported of `resource`'s jurisdiction: outside
 * the recorded one, it stops the run (`refuseOutside`); in it, in a
 * destination that checks itself, it is recorded as the capability's
 * evidence there and then, before the next resource, so a run that
 * fails later has recorded it already. Written only where the capability
 * has no record yet (`unrecordedOnly`), in the statement that writes it:
 * a retry, or the next resource of the same kind, writes nothing again,
 * and it never replaces what a person or an earlier check found, a
 * capability found not to hold above all.
 */
const judge = async (
  db: AdminDatabase,
  destinationId: string,
  check: SelfCheck | undefined,
  resource: ClientResource,
  jurisdiction: string | null | undefined
): Promise<void> => {
  if (jurisdiction !== resource.jurisdiction) {
    await refuseOutside(db, destinationId, check, resource, jurisdiction);
  }
  const capability = capabilityOf[resource.kind];
  if (check !== undefined && capability !== undefined) {
    await recordCapabilityEvidence(
      db,
      "system",
      destinationId,
      observations(check, [capability], "verified"),
      { unrecordedOnly: true }
    );
  }
};

/**
 * Reads `resource`, made by an earlier attempt, back from the provider
 * and judges where it is (`judge`), as a run that made it would have.
 * One the provider no longer has is left to the steps that use it.
 */
const checkJurisdiction = async (
  db: AdminDatabase,
  destinationId: string,
  check: SelfCheck,
  resource: ClientResource,
  provider: Provider
): Promise<void> => {
  const observed = await provider.find(resource);
  if (observed !== undefined) {
    await judge(db, destinationId, check, resource, observed.jurisdiction);
  }
};

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
  db: AdminDatabase,
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
    throw (await holdsClient(
      db,
      held.clientId,
      held.runId,
      held.attempt,
      held.attemptKey
    ))
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
  db: AdminDatabase,
  actor: Actor,
  held: HeldClient,
  selfCheck?: SelfCheck
): Promise<ClientResource[]> => {
  const { clientId } = held;
  if (
    !(await holdsClient(
      db,
      clientId,
      held.runId,
      held.attempt,
      held.attemptKey
    ))
  ) {
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
  const check = checksItself(destination.kind) ? selfCheck : undefined;

  for (const resource of await clientInventory(db, clientId)) {
    const provider = providerFor(api, accountId, resource.kind);
    if (provider === undefined || resource.lifecycle !== "allocated") {
      continue;
    }
    if (resource.providerId !== null) {
      // Made by an earlier attempt: only read back again where the
      // destination checks itself, so a retry checks, and records, every
      // resource the client has, not only the ones it made itself.
      if (check !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
        await checkJurisdiction(db, destination.id, check, resource, provider);
      }
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
    // oxlint-disable-next-line no-await-in-loop -- recorded before the next
    await judge(db, destination.id, check, resource, observed.jurisdiction);
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
