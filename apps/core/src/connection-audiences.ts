import { actorOf } from "@grasp-os/shared/audit";
import {
  connectionBrainAudienceSchema,
  connectionErrors,
} from "@grasp-os/shared/connect";
import type { ConnectionBrainAudienceSetting } from "@grasp-os/shared/connect";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { connectionBrainAudiences, teams } from "./db/core/schema.ts";

// Who may read in the Brain what agents read through a shared connection
// (GRA-1831; the threat model and the decisions are on the issue). An
// admin connects a system once for a group and says who may read what is
// kept of it: one team or everyone, the choice an uploaded document has,
// and nobody until an admin chooses. Access is then decided inside Grasp,
// where every read already checks it; nothing mirrors the other system's
// own permissions, and the admin answers for the scope they choose.
//
// What is kept goes to the shared store for the connection's own group
// (brain-next.ts `connectionGroup`), never for the team or the company
// directly: core puts a reader in that group, at every read, while the
// audience kept here is a group they hold at the reach they read at
// (brain-next.ts `withConnections`). So a change of audience, or of a
// team's members, holds from the next read, all at once, with nothing
// rewritten: narrowing hides what was kept from those taken off, and
// widening shows it to those added, which the admin is told as they
// choose. Back to nobody hides it from everyone and keeps it.
//
// The ways it can fail, which the tests start from: an audience set by
// someone other than one of the company's own admins (Grasp staff
// included), or without a trace; one set on a personal connection, or on
// one that doesn't exist or was disconnected; one naming a team the
// company doesn't have; a row that can't be read opening anything.

/** One row as recall reads it: a connection, and its team or everyone (null). */
export interface ConnectionAudience {
  connectionId: string;
  teamId: string | null;
}

/**
 * Every shared connection's Brain audience as core keeps it now: what
 * each read of the Brain puts its reader in the connections' groups by.
 * One row per shared connection with an audience, so few.
 */
export const connectionAudiences = async (
  database: D1Database
): Promise<ConnectionAudience[]> =>
  await drizzle(database)
    .select({
      connectionId: connectionBrainAudiences.connectionId,
      teamId: connectionBrainAudiences.teamId,
    })
    .from(connectionBrainAudiences);

/** Every shared connection's Brain audience, as an admin last chose it. */
export const readConnectionAudiences = async (
  env: Env,
  identity: Identity
): Promise<ConnectionBrainAudienceSetting[]> => {
  requireAdmin(identity);
  const rows = await drizzle(env.DB)
    .select()
    .from(connectionBrainAudiences)
    .orderBy(connectionBrainAudiences.connectionId);
  return rows.map(({ connectionId, teamId, changedBy, changedAt }) => ({
    connectionId,
    audience: teamId === null ? { kind: "everyone" } : { kind: "team", teamId },
    changedBy,
    changedAt: changedAt.toISOString(),
  }));
};

const connectionIdSchema = z
  .string()
  .min(1)
  .refine((id) => !(id.includes("/") || id.includes(":")), {
    message: "Holds a / or a :",
  });

/**
 * Chooses who may read in the Brain what agents read through the shared
 * connection `connectionId`: one team, everyone, or nobody (`audience`).
 * Admins only, never Grasp staff, who never decide what a client's people
 * connect. One audit event a change; the same audience again records
 * nothing. Throws `connection.invalid` for an audience that isn't one, a
 * team the company doesn't have, or a connection that isn't a shared one
 * connect holds and hasn't disconnected.
 */
export const setConnectionAudience = async (
  env: Env,
  identity: Identity,
  connectionId: unknown,
  audience: unknown
): Promise<void> => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const id = connectionIdSchema.safeParse(connectionId);
  const chosen = connectionBrainAudienceSchema.safeParse(audience);
  if (!(id.success && chosen.success)) {
    throw connectionErrors.create("connection.invalid");
  }
  const db = drizzle(env.DB);
  const [[owner], team] = await Promise.all([
    env.CONNECT.connectionOwners([id.data]),
    chosen.data.kind === "team"
      ? db
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.id, chosen.data.teamId))
          .get()
      : undefined,
  ]);
  // A shared connection connect holds and hasn't disconnected: never a
  // person's own, whose reads are theirs alone.
  if (
    owner?.id !== id.data ||
    owner.ownerUserId !== null ||
    owner.status === "disconnected" ||
    (chosen.data.kind === "team" && team === undefined)
  ) {
    throw connectionErrors.create("connection.invalid");
  }
  const event = outboxedIfChanged(db, {
    actor: actorOf(identity),
    action: "brain.connection_audience.changed",
    target: { type: "connection", id: id.data },
    detail:
      chosen.data.kind === "team"
        ? { who: "team", team: chosen.data.teamId }
        : { who: chosen.data.kind },
  });
  if (chosen.data.kind === "nobody") {
    await auditedBatch(env, db, [
      db
        .delete(connectionBrainAudiences)
        .where(eq(connectionBrainAudiences.connectionId, id.data)),
      event,
    ]);
    return;
  }
  const teamId = chosen.data.kind === "team" ? chosen.data.teamId : null;
  const changedAt = new Date();
  await auditedBatch(env, db, [
    db
      .insert(connectionBrainAudiences)
      .values({
        connectionId: id.data,
        teamId,
        changedBy: identity.userId,
        changedAt,
      })
      .onConflictDoUpdate({
        target: connectionBrainAudiences.connectionId,
        set: { teamId, changedBy: identity.userId, changedAt },
        // Only another audience is a change: the same one again leaves the
        // row, and so the log, as it was.
        setWhere: sql`${connectionBrainAudiences.teamId} IS NOT ${teamId}`,
      }),
    event,
  ]);
};
