/**
 * Discarding a client that was never placed (H4): one added by mistake,
 * or for a test, that has nothing anywhere but its record. Offboarding is
 * for a placed client (src/hosting/offboarding.ts); this removes the
 * record itself, so its id is free for the next client.
 *
 * From the threat model, how discarding could do harm, and what closes it:
 * - Losing a client that runs, or that has resources somewhere: only one
 *   still being provisioned, never placed, with no operation, resource or
 *   Worker recorded, is discarded (`assertDiscardable`). Every one of
 *   those rows references the client, so one written between the check
 *   and the delete fails the delete, and the whole batch with it.
 * - Discarding it under a runner: refused while one is going
 *   (`client_busy`); an ended runner's claim goes with it.
 * - Losing what was done: the audit log keeps every event of it, the
 *   discard included, by its id. Nothing was ever released for it, so
 *   nothing else needs keeping.
 */
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Staff } from "../access.ts";
import { adminDatabase, auditIfChanged } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  clientAdminReads,
  clientPlacements,
  clientProvisions,
  clientResources,
  clientRuns,
  clients,
  clientSealedSecrets,
  clientWatch,
  clientWorkers,
  rolloutTargets,
  settings,
} from "../db/schema.ts";
import { currentRun, hasEnded } from "../runners.ts";

export const discardErrorCodes = [
  /** There's no such client. */
  "client_unknown",
  /** It isn't being provisioned: it's live or offboarded, which offboarding is for. */
  "not_provisioning",
  /** It's placed in a hosting destination: offboard it instead. */
  "placed",
  /** It has an operation, a resource or a Worker recorded: something of it may exist. */
  "has_resources",
  /** A runner is working on it now. */
  "client_busy",
] as const;
export type DiscardErrorCode = (typeof discardErrorCodes)[number];

export class DiscardError extends Error {
  readonly code: DiscardErrorCode;

  constructor(code: DiscardErrorCode, message: string) {
    super(message);
    this.name = "DiscardError";
    this.code = code;
  }
}

/** Whether `table` has a row of client `clientId`. */
const hasRow = async (
  db: AdminDatabase,
  table:
    | typeof clientPlacements
    | typeof clientProvisions
    | typeof clientResources
    | typeof clientWorkers,
  clientId: string
): Promise<boolean> => {
  const rows = await db
    .select({ clientId: table.clientId })
    .from(table)
    .where(eq(table.clientId, clientId))
    .limit(1);
  return rows.length > 0;
};

/** Throws unless client `clientId` may be discarded. */
const assertDiscardable = async (
  env: Env,
  db: AdminDatabase,
  clientId: string
): Promise<void> => {
  const client = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client === undefined) {
    throw new DiscardError("client_unknown", `No client ${clientId}`);
  }
  if (client.status !== "provisioning") {
    throw new DiscardError(
      "not_provisioning",
      `${clientId} is ${client.status}`
    );
  }
  if (await hasRow(db, clientPlacements, clientId)) {
    throw new DiscardError("placed", `${clientId} is placed`);
  }
  const [operation, resources, workers] = await Promise.all([
    hasRow(db, clientProvisions, clientId),
    hasRow(db, clientResources, clientId),
    hasRow(db, clientWorkers, clientId),
  ]);
  if (operation || resources || workers) {
    throw new DiscardError(
      "has_resources",
      `${clientId} has an operation, resource or Worker recorded`
    );
  }
  const run = await currentRun(env, clientId);
  if (run !== null && !hasEnded(run.status)) {
    throw new DiscardError("client_busy", `${clientId} is being worked on`);
  }
};

/**
 * That client `clientId` is still discardable, as SQL: being provisioned,
 * never placed, no operation, resource or Worker recorded. What every
 * statement of a discard holds by, in the same batch as the check.
 */
const stillDiscardable = (clientId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${clients} WHERE ${clients.id} = ${clientId} AND ${clients.status} = 'provisioning') AND NOT EXISTS (SELECT 1 FROM ${clientPlacements} WHERE ${clientPlacements.clientId} = ${clientId}) AND NOT EXISTS (SELECT 1 FROM ${clientProvisions} WHERE ${clientProvisions.clientId} = ${clientId}) AND NOT EXISTS (SELECT 1 FROM ${clientResources} WHERE ${clientResources.clientId} = ${clientId}) AND NOT EXISTS (SELECT 1 FROM ${clientWorkers} WHERE ${clientWorkers.clientId} = ${clientId})`;

/**
 * Discards client `clientId`, as `staff`, audited (`client.discard`):
 * its record and what only the admin keeps of it (settings, sealed
 * secrets, reads, its watch and an ended runner's claim), in one
 * batch. Refused unless it was never placed and has nothing recorded
 * anywhere (`DiscardErrorCode`). Its id is free afterwards.
 */
export const discardClient = async (
  env: Env,
  staff: Staff,
  clientId: string
): Promise<void> => {
  const db = adminDatabase(env.DB);
  await assertDiscardable(env, db, clientId);
  // Every delete holds only while the client is still discardable, read in
  // the same batch: a client that went live, or was placed or given an
  // operation since the check, loses nothing, and no discard is audited.
  const still = stillDiscardable(clientId);
  const results = await db.batch([
    db.delete(settings).where(and(eq(settings.clientId, clientId), still)),
    db
      .delete(clientSealedSecrets)
      .where(and(eq(clientSealedSecrets.clientId, clientId), still)),
    db
      .delete(clientAdminReads)
      .where(and(eq(clientAdminReads.clientId, clientId), still)),
    db
      .delete(clientWatch)
      .where(and(eq(clientWatch.clientId, clientId), still)),
    db
      .delete(rolloutTargets)
      .where(and(eq(rolloutTargets.clientId, clientId), still)),
    db.delete(clientRuns).where(and(eq(clientRuns.clientId, clientId), still)),
    // Last, as its placement, operation, resources and Workers reference
    // it too: one written between the guard and this fails the batch.
    db.delete(clients).where(and(eq(clients.id, clientId), still)),
    // Recorded only if the client's row went.
    auditIfChanged(db, staff, { action: "client.discard", clientId }),
  ]);
  const discarded = results.at(-1);
  if (!Array.isArray(discarded) || discarded.length === 0) {
    // Changed since the check: say how, as the check would now.
    await assertDiscardable(env, db, clientId);
    throw new DiscardError(
      "client_busy",
      `${clientId} changed while it was being discarded`
    );
  }
};
