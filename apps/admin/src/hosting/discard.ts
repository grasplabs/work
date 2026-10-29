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
import { and, eq } from "drizzle-orm";

import type { Staff } from "../access.ts";
import { act, adminDatabase } from "../db/act.ts";
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
  staffAlerts,
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
 * Discards client `clientId`, as `staff`, audited (`client.discard`):
 * its record and what only the admin keeps of it (settings, sealed
 * secrets, reads, its watch, alerts and an ended runner's claim), in one
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
  await act(
    db,
    staff,
    [
      db.delete(settings).where(eq(settings.clientId, clientId)),
      db
        .delete(clientSealedSecrets)
        .where(eq(clientSealedSecrets.clientId, clientId)),
      db
        .delete(clientAdminReads)
        .where(eq(clientAdminReads.clientId, clientId)),
      db.delete(clientWatch).where(eq(clientWatch.clientId, clientId)),
      db.delete(rolloutTargets).where(eq(rolloutTargets.clientId, clientId)),
      db.delete(staffAlerts).where(eq(staffAlerts.clientId, clientId)),
      db.delete(clientRuns).where(eq(clientRuns.clientId, clientId)),
      // Its placement, operation, resources and Workers reference it: one
      // written since the check fails this, and the batch with it.
      db
        .delete(clients)
        .where(
          and(eq(clients.id, clientId), eq(clients.status, "provisioning"))
        ),
    ],
    { action: "client.discard", clientId }
  );
};
