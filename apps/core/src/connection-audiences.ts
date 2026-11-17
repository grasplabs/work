import { actorOf } from "@grasp-os/shared/audit";
import {
  brainConnectionIdSchema,
  connectionBrainAudienceSchema,
  connectionErrors,
} from "@grasp-os/shared/connect";
import type { ConnectionBrainAudienceSetting } from "@grasp-os/shared/connect";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  connectionBrainAudiences,
  connectionBrainErasures,
  teams,
} from "./db/core/schema.ts";

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
 * The read of every shared connection's Brain audience as core keeps it,
 * for one batch with the reader's own records (brain-next.ts
 * `memberGroupsOf`): what each read of the Brain puts its reader in the
 * connections' groups by. One row per shared connection with an audience,
 * so few.
 */
export const audiencesRead = (db: DrizzleD1Database) =>
  db
    .select({
      connectionId: connectionBrainAudiences.connectionId,
      teamId: connectionBrainAudiences.teamId,
    })
    .from(connectionBrainAudiences)
    // Never one of a connection being erased or closed by a disconnect:
    // none has an audience (shared-reads.ts), and a read never trusts one
    // that would.
    .where(
      sql`NOT EXISTS (SELECT 1 FROM ${connectionBrainErasures} WHERE ${connectionBrainErasures.connectionId} = ${connectionBrainAudiences.connectionId} AND (${connectionBrainErasures.erasing} = 1 OR ${connectionBrainErasures.closed} = 1))`
    );

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

/**
 * The audience a row holds: a team's ID, everyone (null), or nobody (no
 * row, `undefined`).
 */
type Held = string | null | undefined;

/** The audience `held`, as the audit log names it: who, and which team. */
const audienceDetail = (
  held: Held,
  prefix: "" | "from"
): Record<string, string> => {
  const who = prefix === "" ? "who" : "from";
  const team = prefix === "" ? "team" : "fromTeam";
  if (held === undefined) {
    return { [who]: "nobody" };
  }
  return held === null
    ? { [who]: "everyone" }
    : { [who]: "team", [team]: held };
};

/**
 * That `connectionId` may be opened to an audience, as SQL: no erasure of
 * what the Brain kept of it is under way, and no disconnect closed it
 * (shared-reads.ts).
 */
const openable = (connectionId: string): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM ${connectionBrainErasures} WHERE ${connectionBrainErasures.connectionId} = ${connectionId} AND (${connectionBrainErasures.erasing} = 1 OR ${connectionBrainErasures.closed} = 1))`;

/**
 * Why `connectionId` may not be opened to an audience now, if it may
 * not: a disconnect closed it, or what the Brain kept of it is being
 * erased.
 */
const unopenableNow = async (
  db: DrizzleD1Database,
  connectionId: string
): Promise<"closed" | "erasing" | undefined> => {
  const row = await db
    .select({
      erasing: connectionBrainErasures.erasing,
      closed: connectionBrainErasures.closed,
    })
    .from(connectionBrainErasures)
    .where(eq(connectionBrainErasures.connectionId, connectionId))
    .get();
  if (row?.closed === true) {
    return "closed";
  }
  return row?.erasing === true ? "erasing" : undefined;
};

/** The audience `connectionId` holds now. */
const heldBy = async (
  db: DrizzleD1Database,
  connectionId: string
): Promise<Held> => {
  const row = await db
    .select({ teamId: connectionBrainAudiences.teamId })
    .from(connectionBrainAudiences)
    .where(eq(connectionBrainAudiences.connectionId, connectionId))
    .get();
  return row?.teamId;
};

/**
 * Refuses `chosen` for `connectionId` unless it is a shared connection
 * connect holds and hasn't disconnected, never a person's own, whose
 * reads are theirs alone, and a team it names is the company's. Only for
 * an audience that reads: narrowing to nobody needs neither, so a
 * connection disconnected or gone can always be closed.
 */
const requireOpenable = async (
  env: Env,
  db: DrizzleD1Database,
  connectionId: string,
  teamId: string | null
): Promise<void> => {
  const [[owner], team] = await Promise.all([
    env.CONNECT.connectionOwners([connectionId]),
    teamId === null
      ? undefined
      : db
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.id, teamId))
          .get(),
  ]);
  if (
    owner?.id !== connectionId ||
    owner.ownerUserId !== null ||
    owner.status === "disconnected" ||
    (teamId !== null && team === undefined)
  ) {
    throw connectionErrors.create("connection.invalid");
  }
};

/**
 * Chooses who may read in the Brain what agents read through the shared
 * connection `connectionId`: one team, everyone, or nobody (`audience`).
 * Admins only, never Grasp staff, who never decide what a client's people
 * connect. One audit event a change, with the audience before and after;
 * the same audience again records nothing. Throws `connection.invalid`
 * for an audience that isn't one, and, for one that reads, a team the
 * company doesn't have or a connection that isn't a shared one connect
 * holds and hasn't disconnected. Nobody is taken on any connection.
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
  const id = brainConnectionIdSchema.safeParse(connectionId);
  const chosen = connectionBrainAudienceSchema.safeParse(audience);
  if (!(id.success && chosen.success)) {
    throw connectionErrors.create("connection.invalid");
  }
  const db = drizzle(env.DB);
  let wanted: Held;
  if (chosen.data.kind === "nobody") {
    wanted = undefined;
  } else {
    wanted = chosen.data.kind === "team" ? chosen.data.teamId : null;
    await requireOpenable(env, db, id.data, wanted);
  }
  // Written only over the audience read just before, so the event says
  // what it changed from; read again and written again if another change
  // landed in between, until it holds what was chosen.
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- again only after another change
    const [held, unopenable] = await Promise.all([
      heldBy(db, id.data),
      unopenableNow(db, id.data),
    ]);
    if (held === wanted) {
      return;
    }
    // Never opened while what the Brain kept of it is being erased, nor
    // once a disconnect closed it, though connect said it was connected a
    // moment ago (shared-reads.ts): checked again in the statement that
    // writes it.
    if (wanted !== undefined && unopenable === "closed") {
      throw connectionErrors.create("connection.invalid");
    }
    if (wanted !== undefined && unopenable === "erasing") {
      throw connectionErrors.create("connection.brain_erasing");
    }
    const event = outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "brain.connection_audience.changed",
      target: { type: "connection", id: id.data },
      detail: {
        ...audienceDetail(held, "from"),
        ...audienceDetail(wanted, ""),
      },
    });
    const thisRow = eq(connectionBrainAudiences.connectionId, id.data);
    const asRead = and(
      thisRow,
      sql`${connectionBrainAudiences.teamId} IS ${held ?? null}`
    );
    const changedAt = new Date();
    let write;
    if (wanted === undefined) {
      write = db.delete(connectionBrainAudiences).where(asRead);
    } else if (held === undefined) {
      write = db
        .insert(connectionBrainAudiences)
        .select(
          sql`SELECT ${id.data}, ${wanted}, ${identity.userId}, ${changedAt.getTime()} WHERE ${openable(id.data)}`
        )
        .onConflictDoNothing();
    } else {
      write = db
        .update(connectionBrainAudiences)
        .set({ teamId: wanted, changedBy: identity.userId, changedAt })
        .where(and(asRead, openable(id.data)));
    }
    // oxlint-disable-next-line no-await-in-loop -- again only after another change
    await auditedBatch(env, db, [write, event]);
  }
};
