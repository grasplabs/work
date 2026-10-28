/**
 * Offboarding a placed client, then deleting its resources (spec 40.1,
 * GRA-384; decided on 2026-10-28 by the coordinator on Nick's delegation):
 *
 * - Offboarding takes its hostname out of the router's map at once and
 *   records it offboarded. Nothing is deleted.
 * - Deleting its resources is a second, explicit staff action, allowed only
 *   once `retentionMs` has passed since it was offboarded. Until the export
 *   of a client exists (GRA-413), staff confirm that none was made; once it
 *   does, a fresh export is required instead.
 * - Every resource deleted is one its inventory records for its own
 *   deployment, in its own destination, checked against the provider
 *   first. Nothing here runs by itself: no retry, clock or rollout ever
 *   deletes.
 *
 * Threat model, each tried in test/client-offboarding.test.ts:
 * - Deleting a live client's data: refused unless offboarded, and the
 *   retention window over.
 * - Deleting what isn't the client's: only inventory rows its deployment
 *   owns, in its destination; a database whose name the provider gives
 *   another id is refused and kept.
 * - An offboarded client served again: its operation refuses to run for an
 *   offboarded client, so no release or provisioning attempt puts its
 *   hostname back.
 * - A deletion that stops part way (a bucket still holding objects, an API
 *   that fails): run again, it goes on; what's gone counts as deleted.
 * - Anyone but staff: the server functions are behind Access.
 */
import { and, asc, count, eq, isNull } from "drizzle-orm";

import type { Staff } from "../access.ts";
import {
  deleteD1Database,
  deleteR2Bucket,
  expireAllObjects,
  findD1Database,
} from "../cloudflare/accounts.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { deleteTargetScript } from "../cloudflare/workers.ts";
import { actIfChanged, adminDatabase, audit } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clientPlacements, clientResources, clients } from "../db/schema.ts";
import { clientDomain, deployerApi } from "../deploy/context.ts";
import { unregisterHostname } from "../deploy/router.ts";
import { currentRun, hasEnded } from "../runners.ts";
import { clientInventory, destinationOf, placementOf } from "./inventory.ts";
import type { ClientPlacement, ClientResource } from "./inventory.ts";

/** How long an offboarded client's resources are kept before they may be deleted. */
export const retentionMs = 30 * 24 * 60 * 60 * 1000;

export const offboardingErrorCodes = [
  /** No such client. */
  "client_unknown",
  /** The client isn't placed in a hosting destination: this path doesn't reach it. */
  "not_placed",
  /** Something is working on the client: it's offboarded once that has ended. */
  "client_busy",
  /** Deleting a client that isn't offboarded. */
  "not_offboarded",
  /** Deleting before the retention window from its offboarding is over. */
  "retention_running",
  /** Deleting without staff confirming that no export of the client was made. */
  "export_unconfirmed",
  /** An inventory row, or what the provider has under its name, isn't the client's own. */
  "resource_not_owned",
  /** Its destination isn't one the admin deletes in. */
  "destination_unsupported",
] as const;
export type OffboardingErrorCode = (typeof offboardingErrorCodes)[number];

/** Why offboarding or deleting was refused: a fixed code and identifiers only. */
export class OffboardingError extends Error {
  readonly code: OffboardingErrorCode;

  constructor(code: OffboardingErrorCode, message: string) {
    super(message);
    this.name = "OffboardingError";
    this.code = code;
  }
}

/** Client `clientId`'s status and when it was offboarded, and its placement. */
const placedClientOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<{
  status: "provisioning" | "active" | "offboarded";
  offboardedAt: Date | null;
  placement: ClientPlacement;
}> => {
  const client = await db
    .select({ status: clients.status, offboardedAt: clients.offboardedAt })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    throw new OffboardingError("client_unknown", `No client ${clientId}`);
  }
  const placement = await placementOf(db, clientId);
  if (placement === undefined) {
    throw new OffboardingError(
      "not_placed",
      `${clientId} isn't placed in a hosting destination`
    );
  }
  return { ...client, placement };
};

/** Throws `client_busy` while a runner still works on client `clientId`. */
const assertIdle = async (env: Env, clientId: string): Promise<void> => {
  const run = await currentRun(env, clientId);
  if (run !== null && !hasEnded(run.status)) {
    throw new OffboardingError(
      "client_busy",
      `${clientId} has a runner still going: ${run.runId}`
    );
  }
};

/**
 * Offboards placed client `clientId`, as `staff`: records it offboarded,
 * then takes its hostname out of the router's map. Offboarding one that is
 * already takes its hostname out again, as a first try that stopped before
 * it did leaves it. Refused while a runner still works on it.
 */
export const offboardPlacedClient = async (
  env: Env,
  staff: Staff,
  clientId: string
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const client = await placedClientOf(db, clientId);
  if (client.status !== "offboarded") {
    await assertIdle(env, clientId);
    const now = new Date();
    const offboarded = await actIfChanged(
      db,
      staff,
      db
        .update(clients)
        .set({ status: "offboarded", offboardedAt: now, updatedAt: now })
        .where(
          and(eq(clients.id, clientId), eq(clients.status, client.status))
        ),
      {
        action: "client.offboard",
        clientId,
        target: client.placement.destinationId,
      }
    );
    if (!offboarded) {
      throw new OffboardingError(
        "client_busy",
        `${clientId} changed as it was offboarded`
      );
    }
  }
  const domain = clientDomain(env);
  if (domain !== null) {
    await unregisterHostname(
      env.ROUTER_HOSTS,
      `${clientId}.${domain}`,
      clientId,
      // Still offboarded right before the delete: nothing took it back.
      async () => {
        const now = await placedClientOf(db, clientId);
        if (now.status !== "offboarded") {
          throw new OffboardingError(
            "client_busy",
            `${clientId} isn't offboarded any more`
          );
        }
      }
    );
  }
};

/** What a deletion did: resources deleted, and buckets still emptying. */
export interface Deletion {
  deleted: number;
  /** Buckets that held objects: each now expires them, and a later run deletes it. */
  emptying: string[];
}

/** The order resources go in: scripts (and their objects) first, then databases, then buckets. */
const kindOrder: Readonly<Record<ClientResource["kind"], number>> = {
  worker_script: 0,
  durable_object_class: 1,
  d1_database: 2,
  r2_bucket: 3,
};

/** Throws `resource_not_owned` unless `row` is a resource of `placement`'s own. */
const assertOwned = (row: ClientResource, placement: ClientPlacement): void => {
  if (
    row.owner !== placement.deploymentId ||
    row.destinationId !== placement.destinationId
  ) {
    throw new OffboardingError(
      "resource_not_owned",
      `${row.role} isn't ${placement.clientId}'s own in ${placement.destinationId}`
    );
  }
};

/** Records `row` deleted, as it is now gone from its destination. */
const recordDeleted = async (
  db: AdminDatabase,
  row: ClientResource
): Promise<void> => {
  await db
    .update(clientResources)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(clientResources.clientId, row.clientId),
        eq(clientResources.role, row.role),
        isNull(clientResources.deletedAt)
      )
    );
};

/** Where the destination's resources are: its account, and its namespace for scripts. */
interface Where {
  api: CloudflareApi;
  accountId: string;
  namespace: string | null;
}

/**
 * Deletes `row` from its destination: `deleted`, or `emptying` for a
 * bucket that still holds objects, which now expires them. A database is
 * deleted only by the id the provider gives its recorded name, and only
 * when that's the id recorded.
 */
const deleteResource = async (
  { api, accountId, namespace }: Where,
  row: ClientResource
): Promise<"deleted" | "emptying"> => {
  switch (row.kind) {
    case "worker_script": {
      await deleteTargetScript(api, {
        accountId,
        scriptName: row.physicalName,
        namespace,
      });
      return "deleted";
    }
    case "durable_object_class": {
      // Deleted with its script (`force`), which comes first.
      return "deleted";
    }
    case "d1_database": {
      if (row.providerId === null) {
        return "deleted";
      }
      const found = await findD1Database(api, accountId, row.physicalName);
      if (found === undefined) {
        return "deleted";
      }
      if (found.uuid !== row.providerId) {
        throw new OffboardingError(
          "resource_not_owned",
          `${row.physicalName} is another database than the one recorded`
        );
      }
      await deleteD1Database(api, accountId, found.uuid);
      return "deleted";
    }
    case "r2_bucket": {
      const deleted = await deleteR2Bucket(
        api,
        accountId,
        row.physicalName,
        row.jurisdiction
      );
      if (deleted === "deleted") {
        return "deleted";
      }
      await expireAllObjects(
        api,
        accountId,
        row.physicalName,
        row.jurisdiction
      );
      return "emptying";
    }
    default: {
      return row.kind satisfies never;
    }
  }
};

/**
 * Deletes offboarded placed client `clientId`'s resources from its
 * destination, as `staff`, each recorded deleted as it goes; a bucket that
 * still holds objects expires them and is deleted by a later run. Refused
 * unless the client is offboarded, the retention window since is over
 * (`now`), staff confirm that no export was made (`exportConfirmed`, until
 * GRA-413), and nothing works on it. Audited with what it did.
 */
export const deletePlacedClient = async (
  env: Env,
  staff: Staff,
  clientId: string,
  {
    exportConfirmed,
    now = new Date(),
  }: { exportConfirmed: boolean; now?: Date }
): Promise<Deletion> => {
  const db = adminDatabase(env.DB);
  const client = await placedClientOf(db, clientId);
  if (client.status !== "offboarded" || client.offboardedAt === null) {
    throw new OffboardingError(
      "not_offboarded",
      `${clientId} isn't offboarded`
    );
  }
  const allowedFrom = client.offboardedAt.getTime() + retentionMs;
  if (now.getTime() < allowedFrom) {
    throw new OffboardingError(
      "retention_running",
      `${clientId}'s resources are kept until ${new Date(allowedFrom).toISOString()}`
    );
  }
  if (!exportConfirmed) {
    throw new OffboardingError(
      "export_unconfirmed",
      `Deleting ${clientId} wants staff to confirm no export of it was made`
    );
  }
  await assertIdle(env, clientId);
  const { placement } = client;
  const destination = await destinationOf(db, placement.destinationId);
  if (destination.accountId === null || destination.kind === "workerd") {
    throw new OffboardingError(
      "destination_unsupported",
      `${destination.id} isn't a Cloudflare destination the admin deletes in`
    );
  }
  const where: Where = {
    api: await deployerApi(env),
    accountId: destination.accountId,
    namespace:
      destination.kind === "workers_for_platforms"
        ? destination.namespace
        : null,
  };
  const recorded = await clientInventory(db, clientId);
  const inventory = recorded
    .filter((row) => row.deletedAt === null)
    .toSorted((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);
  // Every row checked before anything is deleted.
  for (const row of inventory) {
    assertOwned(row, placement);
  }
  const deletion: Deletion = { deleted: 0, emptying: [] };
  for (const row of inventory) {
    // oxlint-disable-next-line no-await-in-loop -- in order: scripts first
    const outcome = await deleteResource(where, row);
    if (outcome === "emptying") {
      deletion.emptying.push(row.physicalName);
    } else {
      // oxlint-disable-next-line no-await-in-loop -- each recorded as it goes
      await recordDeleted(db, row);
      deletion.deleted += 1;
    }
  }
  await audit(db, staff, {
    action: "client.delete_resources",
    clientId,
    target: placement.destinationId,
    detail: {
      deleted: deletion.deleted,
      emptying: deletion.emptying.length,
    },
  });
  return deletion;
};

/** An offboarded placed client, as Platform's Offboarded page lists it. */
export interface OffboardedClient {
  clientId: string;
  name: string;
  destinationId: string;
  offboardedAt: Date;
  /** When its resources may be deleted: `retentionMs` after it was offboarded. */
  deletableFrom: Date;
  /** Its resources still in its destination, as its inventory records them. */
  remaining: number;
}

/** Every offboarded placed client, the longest offboarded first. */
export const offboardedClients = async (
  db: AdminDatabase
): Promise<OffboardedClient[]> => {
  const rows = await db
    .select({
      clientId: clients.id,
      name: clients.name,
      destinationId: clientPlacements.destinationId,
      offboardedAt: clients.offboardedAt,
    })
    .from(clients)
    .innerJoin(clientPlacements, eq(clientPlacements.clientId, clients.id))
    .where(eq(clients.status, "offboarded"))
    .orderBy(asc(clients.offboardedAt));
  const remaining = await db
    .select({ clientId: clientResources.clientId, left: count() })
    .from(clientResources)
    .where(isNull(clientResources.deletedAt))
    .groupBy(clientResources.clientId);
  const left = new Map(remaining.map(({ clientId, left: n }) => [clientId, n]));
  return rows.flatMap(({ offboardedAt, ...row }) =>
    offboardedAt === null
      ? []
      : [
          {
            ...row,
            offboardedAt,
            deletableFrom: new Date(offboardedAt.getTime() + retentionMs),
            remaining: left.get(row.clientId) ?? 0,
          },
        ]
  );
};
