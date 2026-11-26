import { actorOf } from "@grasp-os/shared/audit";
import {
  brainConnectionIdSchema,
  connectionAudienceSchema,
  connectionErrors,
  connectionOwnersMax,
} from "@grasp-os/shared/connect";
import type {
  ConnectionAudience,
  ConnectionAudienceSetting,
} from "@grasp-os/shared/connect";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { placesListing, syncErrors } from "@grasp-os/shared/sync";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  appendAuditEvent,
  auditedBatch,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import {
  brainSyncSources,
  connectionAudiences,
  connectionBrainErasures,
  teams,
} from "./db/core/schema.ts";

// A shared connection's one audience (GRA-1831, GRA-2322; the threat
// models and the decisions are on the issues). An admin connects a system
// once for a group and says who it is for: one team or everyone, the
// choice an uploaded document has, and nobody until an admin chooses.
// That group alone uses it in chat, with no grant (ungranted-reads.ts),
// reaches an App that read it, itself or through the workflows it reaches
// (app-provenance.ts; a workflow shared on its own isn't checked yet:
// GRA-2333), and reads
// in the Brain what agents read through it. Access is then decided inside
// Grasp, where every call and read already checks it; nothing mirrors the
// other system's own permissions, and the admin answers for the scope
// they choose.
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

/** One row as every path reads it: a connection, and its team or everyone (null). */
export interface AudienceRow {
  connectionId: string;
  teamId: string | null;
}

/**
 * The read of every shared connection's audience as core keeps it,
 * for one batch with the reader's own records (brain-next.ts
 * `memberGroupsOf`): what each read of the Brain puts its reader in the
 * connections' groups by. One row per shared connection with an audience,
 * so few.
 */
export const audiencesRead = (db: DrizzleD1Database) =>
  db
    .select({
      connectionId: connectionAudiences.connectionId,
      teamId: connectionAudiences.teamId,
    })
    .from(connectionAudiences)
    // Never one of a connection being erased or closed by a disconnect:
    // none has an audience (shared-reads.ts), and a read never trusts one
    // that would.
    .where(
      sql`NOT EXISTS (SELECT 1 FROM ${connectionBrainErasures} WHERE ${connectionBrainErasures.connectionId} = ${connectionAudiences.connectionId} AND (${connectionBrainErasures.erasing} = 1 OR ${connectionBrainErasures.closed} = 1))`
    )
    // In one order, with the places of each (`sharedPlacesRead`): a reader
    // past the bound of groups leaves out the same places each read
    // (brain-next.ts `readerGroupsOf`).
    .orderBy(connectionAudiences.connectionId);

/**
 * Of `audiences`, those of a connection connect holds as active now, read
 * from connect at each read (GRA-2227). One the provider revoked, which
 * connect marks as needing someone to sign in again (`needs_reauth`),
 * gives nobody what the Brain kept of it, and keeps all of it: signing in
 * again to the same account makes the same connection active, and it is
 * read as before. One connect doesn't know gives nobody anything either.
 * Only a disconnect in Grasp, or an un-pick, erases (shared-reads.ts,
 * brain-sync.ts).
 */
export const activeAudiences = async <Row extends AudienceRow>(
  env: Pick<Env, "CONNECT">,
  audiences: readonly Row[]
): Promise<Row[]> => {
  const pages: string[][] = [];
  for (let start = 0; start < audiences.length; start += connectionOwnersMax) {
    pages.push(
      audiences
        .slice(start, start + connectionOwnersMax)
        .map(({ connectionId }) => connectionId)
    );
  }
  const owners = await Promise.all(
    pages.map(async (page) => await env.CONNECT.connectionOwners(page))
  );
  const active = new Set(
    owners.flat().flatMap(({ id, status }) => (status === "active" ? [id] : []))
  );
  return audiences.filter(({ connectionId }) => active.has(connectionId));
};

/**
 * The read of every place a shared connection syncs into the Brain now
 * (brain-sync.ts, GRA-1719), for the same batch as `audiencesRead`: each
 * picked place still live (never one un-picked, `dropped`), of a
 * connection with an audience. What it synced is kept for the place's
 * own group (brain-next.ts `placeGroupOf`), which core puts a reader in
 * only beside the connection's own group: so an un-pick hides a place
 * from the next read on, in the one statement that marks it dropped.
 */
export const sharedPlacesRead = (db: DrizzleD1Database) =>
  db
    .select({
      connectionId: brainSyncSources.connectionId,
      feed: brainSyncSources.feed,
      place: brainSyncSources.place,
    })
    .from(brainSyncSources)
    .where(
      and(
        isNull(brainSyncSources.personId),
        eq(brainSyncSources.dropped, false),
        ne(brainSyncSources.place, placesListing),
        sql`EXISTS (SELECT 1 FROM ${connectionAudiences} WHERE ${connectionAudiences.connectionId} = ${brainSyncSources.connectionId})`
      )
    )
    // In one order, so a reader past the bound of groups leaves out the
    // same places each read (brain-next.ts `readerGroupsOf`).
    .orderBy(
      brainSyncSources.connectionId,
      brainSyncSources.feed,
      brainSyncSources.place
    );

/** Every shared connection's audience, as an admin last chose it. */
export const readConnectionAudiences = async (
  env: Env,
  identity: Identity
): Promise<ConnectionAudienceSetting[]> => {
  requireAdmin(identity);
  const db = drizzle(env.DB);
  // One snapshot: an erasure that starts takes the audience away in the
  // same batch, so both are read as of one moment.
  const [rows, erasing] = await db.batch([
    db
      .select()
      .from(connectionAudiences)
      .orderBy(connectionAudiences.connectionId),
    db
      .select({ connectionId: connectionBrainErasures.connectionId })
      .from(connectionBrainErasures)
      .where(eq(connectionBrainErasures.erasing, true))
      .orderBy(connectionBrainErasures.connectionId),
  ]);
  const erasingIds = new Set(erasing.map(({ connectionId }) => connectionId));
  const chosen: ConnectionAudienceSetting[] = rows.map(
    ({ connectionId, teamId, changedBy, changedAt }) => ({
      connectionId,
      audience:
        teamId === null ? { kind: "everyone" } : { kind: "team", teamId },
      erasing: erasingIds.has(connectionId),
      changedBy,
      changedAt: changedAt.toISOString(),
    })
  );
  const audienced = new Set(rows.map(({ connectionId }) => connectionId));
  // Being erased, so with no audience: listed all the same, so a page
  // can say so and offer no choice until it has ended.
  const beingErased: ConnectionAudienceSetting[] = erasing.flatMap(
    ({ connectionId }) =>
      audienced.has(connectionId)
        ? []
        : [
            {
              connectionId,
              audience: { kind: "nobody" },
              erasing: true,
              changedBy: null,
              changedAt: null,
            },
          ]
  );
  return [...chosen, ...beingErased].toSorted((one, other) =>
    one.connectionId.localeCompare(other.connectionId)
  );
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

/** `audience` as a row holds it (`Held`). */
const heldOf = (audience: ConnectionAudience): Held => {
  if (audience.kind === "nobody") {
    return undefined;
  }
  return audience.kind === "team" ? audience.teamId : null;
};

/** Whether `one` and `other` are the same audience: the same team, if one. */
export const sameAudience = (
  one: ConnectionAudience,
  other: ConnectionAudience
): boolean => heldOf(one) === heldOf(other);

/** `audience` as the audit log names it: who, and which team. */
export const audienceFields = (
  audience: ConnectionAudience
): Record<string, string> => audienceDetail(heldOf(audience), "");

/**
 * Refuses (`sync.unacknowledged`), and records the refusal as `action`,
 * unless `acknowledged` is `audience`: the admin confirmed that it will
 * read everything a shared connection brings, the places picked on it
 * included, whatever the source's permissions (GRA-2207).
 */
export const requireAcknowledged = async (
  env: Env,
  identity: Identity,
  action: "connection.sync_places" | "brain.connection_audience.changed",
  connectionId: string,
  audience: ConnectionAudience,
  acknowledged: ConnectionAudience | undefined,
  detail: Record<string, string> = {}
): Promise<void> => {
  if (acknowledged !== undefined && sameAudience(acknowledged, audience)) {
    return;
  }
  await appendAuditEvent(env, {
    actor: actorOf(identity),
    action,
    target: { type: "connection", id: connectionId },
    detail: {
      ...detail,
      outcome: "refused",
      reason: "sync.unacknowledged",
      ...audienceFields(audience),
    },
  });
  throw syncErrors.create("sync.unacknowledged");
};

/** The audience `connectionId` holds now. */
const heldBy = async (
  db: DrizzleD1Database,
  connectionId: string
): Promise<Held> => {
  const row = await db
    .select({ teamId: connectionAudiences.teamId })
    .from(connectionAudiences)
    .where(eq(connectionAudiences.connectionId, connectionId))
    .get();
  return row?.teamId;
};

/** The audience a row holds (`Held`), as an admin chose it. */
export const audienceOf = (held: Held): ConnectionAudience => {
  if (held === undefined) {
    return { kind: "nobody" };
  }
  return held === null ? { kind: "everyone" } : { kind: "team", teamId: held };
};

/**
 * The audience the shared connection `connectionId` holds now: nobody
 * when it has none.
 */
export const connectionAudienceOf = async (
  env: Env,
  connectionId: string
): Promise<ConnectionAudience> =>
  audienceOf(await heldBy(drizzle(env.DB), connectionId));

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
 * Chooses who may use the shared connection `connectionId`, in their own
 * chat, through an App that holds it and in the Brain: one team,
 * everyone, or nobody (`audience`).
 * Admins only, never Grasp staff, who never decide what a client's people
 * connect. One audit event a change, with the audience before and after;
 * the same audience again records nothing. Throws `connection.invalid`
 * for an audience that isn't one, and, for one that reads, a team the
 * company doesn't have or a connection that isn't a shared one connect
 * holds and hasn't disconnected. Nobody is taken on any connection.
 *
 * `from` is the audience the admin was looking at: the change is made
 * only while that is still the one held, compared in the statement that
 * writes, so a page left open never opens access over a change it didn't
 * see (an erase, another admin's choice) without its confirmation.
 * Otherwise it throws `connection.audience_changed` and changes
 * nothing; the page reads the audience again. Choosing what is held
 * already changes nothing, whatever `from` says.
 *
 * A change that lets anyone read who couldn't before (to a team from
 * nobody or another team, or to everyone) is refused
 * (`sync.unacknowledged`), and recorded, unless `acknowledged` is the
 * audience chosen: the admin confirmed it reads everything the
 * connection brings, whatever the source's permissions (GRA-2207).
 */
export const setConnectionAudience = async (
  env: Env,
  identity: Identity,
  connectionId: unknown,
  audience: unknown,
  from: unknown,
  acknowledged?: unknown
): Promise<void> => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const id = brainConnectionIdSchema.safeParse(connectionId);
  const chosen = connectionAudienceSchema.safeParse(audience);
  const seen = connectionAudienceSchema.safeParse(from);
  const confirmed = connectionAudienceSchema.optional().safeParse(acknowledged);
  if (!(id.success && chosen.success && seen.success && confirmed.success)) {
    throw connectionErrors.create("connection.invalid");
  }
  const expected = heldOf(seen.data);
  const db = drizzle(env.DB);
  let wanted: Held;
  if (chosen.data.kind === "nobody") {
    wanted = undefined;
  } else {
    wanted = chosen.data.kind === "team" ? chosen.data.teamId : null;
    await requireOpenable(env, db, id.data, wanted);
  }
  // Written only over the audience read just before, which must be the
  // one the admin saw, so the event says what it changed from; read again
  // if another change landed in between, which then refuses it.
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- again only after another change
    const [held, unopenable] = await Promise.all([
      heldBy(db, id.data),
      unopenableNow(db, id.data),
    ]);
    if (held === wanted) {
      return;
    }
    if (held !== expected) {
      throw connectionErrors.create("connection.audience_changed");
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
    // Opens to someone new: everyone from anything less, or a team from
    // nobody or another team.
    if (wanted !== undefined && held !== null) {
      // oxlint-disable-next-line no-await-in-loop -- refuses, ending the loop
      await requireAcknowledged(
        env,
        identity,
        "brain.connection_audience.changed",
        id.data,
        chosen.data,
        confirmed.data
      );
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
    const thisRow = eq(connectionAudiences.connectionId, id.data);
    const asRead = and(
      thisRow,
      sql`${connectionAudiences.teamId} IS ${held ?? null}`
    );
    const changedAt = new Date();
    let write;
    if (wanted === undefined) {
      write = db.delete(connectionAudiences).where(asRead);
    } else if (held === undefined) {
      write = db
        .insert(connectionAudiences)
        .select(
          sql`SELECT ${id.data}, ${wanted}, ${identity.userId}, ${changedAt.getTime()} WHERE ${openable(id.data)}`
        )
        .onConflictDoNothing();
    } else {
      write = db
        .update(connectionAudiences)
        .set({ teamId: wanted, changedBy: identity.userId, changedAt })
        .where(and(asRead, openable(id.data)));
    }
    // oxlint-disable-next-line no-await-in-loop -- again only after another change
    await auditedBatch(env, db, [write, event]);
  }
};
