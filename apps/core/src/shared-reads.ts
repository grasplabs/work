import {
  actorOf,
  auditActorSchema,
  createAuditEvent,
} from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import {
  brainConnectionIdSchema,
  connectionErrors,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorName, log } from "@grasp-os/shared/log";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  outboxedEventWhere,
  uuidFromHash,
} from "./audit-outbox.ts";
import { erasingAtOnce, eraseSources } from "./brain-next-origins.ts";
import {
  connectionBrainAudiences,
  connectionBrainErasures,
  connectionBrainReads,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// The records the Brain kept from what agents read through a shared
// connection (GRA-1831; the threat model and the decisions are on the
// issue), and erasing them. Core names each one here before the Brain is
// given its key (`claimSharedRead`), as `brain_uploads` names an upload,
// so every key the Brain holds of a connection is listed, and erasing the
// connection's records erases exactly those.
//
// An erasure is an admin's hard delete, for good: an admin's "Erase what
// the Brain kept" (`eraseBrainReads`), or disconnecting the connection,
// which for a shared connection is an admin's act too (connect's
// `connection.disconnect`, capture-erasures.ts). Hiding and keeping is
// the audience's nobody (connection-audiences.ts). An erasure starts in
// one batch: the connection's audience goes, so nobody's reader holds its
// group from then on (brain-next.ts `withConnections`), its generation
// goes up, so what it keeps after an erasure that ended is under keys
// never erased, and it is marked under way. From then on nothing is
// claimed, and no audience can be chosen, until it ends. Then each key of
// an older generation is erased in the Brain, which closes it in the
// ledger (a late add refused, a restore replaying it), and forgotten
// here, a page at a time; once none is left, the erasure ends, with its
// one event, `brain.shared_reads.erased` and how many records it erased.
// A started erasure is owed until then, and only the clock takes it on:
// each minute, every erasure under way a step, out of one budget of calls
// to the Brain (`completeOwedErasures`), so a Worker that stopped
// part-way, or a store out of reach, delays it and never drops it, and
// nothing races it in the background. Nobody reads its records from the
// moment it starts, so waiting for the clock shows nobody anything.
//
// A disconnect also closes the connection here for good (`closed`): no
// audience is opened on it again, whatever was checked before the
// disconnect landed (connection-audiences.ts), so nothing claimed after
// it can outlive its erasure.

/** A record's key under its connection: its generation, then a hash. */
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * How many calls to the Brain's store one run of the clock spends on
 * erasures at most, one a record. The platform's own limit is Workers'
 * subrequests per invocation: 10,000 by default on Workers Paid, as
 * Cloudflare's Workers limits page states it (checked 17 November 2026;
 * D1 queries count too; on-prem workerd has none). Erasures take a tenth
 * of it; the other 9,000 are left for the clock's other tasks in the same
 * invocation (the audit drain, the Brain's work queue and hand-overs, the
 * onboarding's and the uploads' owed work), which is an estimate, not a
 * measurement: each takes a few dozen calls a tick today. Every erasure
 * under way shares it (`completeOwedErasures`); what is left is erased by
 * the next run, so any number is erased in the end.
 */
export const brainCallsPerTick = 1000;

/** A page of keys erased and forgotten in one go. */
const erasedPerPage = 100;

/**
 * Names a record the Brain is to keep of what an agent read through the
 * shared connection `connectionId`, the call or item its producer hashed
 * as `hash` (a SHA-256 in hex), and answers the source to add it as, in
 * the connection's current generation: or nothing when no audience is
 * chosen for it now, or an erasure of it is under way, or a disconnect
 * closed it. Neither ever has an audience (an erasure's start and a
 * disconnect take it away, and none can be chosen meanwhile:
 * connection-audiences.ts); the statement checks it all the same, as
 * every read that trusts an audience does. Decided in the statement that names it, so
 * an erasure that starts after it lists it, and one that started before
 * refuses it. The same record again is the same source, named once.
 */
export const claimSharedRead = async (
  env: Pick<Env, "DB">,
  connectionId: string,
  hash: string,
  readAt: Date
): Promise<{ producer: "connected"; id: string } | undefined> => {
  const connection = brainConnectionIdSchema.parse(connectionId);
  const hashed = hashSchema.parse(hash);
  const generation = sql`COALESCE((SELECT ${connectionBrainErasures.generation} FROM ${connectionBrainErasures} WHERE ${connectionBrainErasures.connectionId} = ${connection}), 0)`;
  const [named] = await drizzle(env.DB)
    .insert(connectionBrainReads)
    .select(
      sql`SELECT ${connection} || '/' || ${generation} || '/' || ${hashed}, ${connection}, ${generation}, ${readAt.getTime()}
        WHERE EXISTS (SELECT 1 FROM ${connectionBrainAudiences} WHERE ${connectionBrainAudiences.connectionId} = ${connection})
          AND NOT EXISTS (SELECT 1 FROM ${connectionBrainErasures} WHERE ${connectionBrainErasures.connectionId} = ${connection} AND (${connectionBrainErasures.erasing} = 1 OR ${connectionBrainErasures.closed} = 1))`
    )
    // Named already: the same source, as it was first named.
    .onConflictDoUpdate({
      target: connectionBrainReads.sourceId,
      set: { sourceId: sql`${connectionBrainReads.sourceId}` },
    })
    .returning({ sourceId: connectionBrainReads.sourceId });
  return named === undefined
    ? undefined
    : { producer: "connected", id: named.sourceId };
};

/** What the Brain keeps of one shared connection now: how many records, and when the last was read. */
export interface KeptOf {
  connectionId: string;
  records: number;
  lastReadAt: Date;
}

/**
 * What the Brain keeps of each of the shared connections `connectionIds`
 * now, how many records and when the last was read; a connection with
 * none is left out, and so is one with no audience, being erased or
 * closed, decided in this statement as the reader's own audience read
 * decides it (connection-audiences.ts `audiencesRead`): an erasure that
 * starts after the reader's groups were read, and before this, shows
 * nothing of what it erases. For connections a reader holds (brain-next.ts
 * `readableConnectionsOf`).
 */
export const keptOf = async (
  env: Pick<Env, "DB">,
  connectionIds: readonly string[]
): Promise<KeptOf[]> => {
  if (connectionIds.length === 0) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({
      connectionId: connectionBrainReads.connectionId,
      records: sql<number>`count(*)`,
      lastReadAt: sql<number>`max(${connectionBrainReads.readAt})`,
    })
    .from(connectionBrainReads)
    .where(
      sql`${inList(connectionBrainReads.connectionId, connectionIds)}
        AND EXISTS (SELECT 1 FROM ${connectionBrainAudiences} WHERE ${connectionBrainAudiences.connectionId} = ${connectionBrainReads.connectionId})
        AND NOT EXISTS (SELECT 1 FROM ${connectionBrainErasures} WHERE ${connectionBrainErasures.connectionId} = ${connectionBrainReads.connectionId} AND (${connectionBrainErasures.erasing} = 1 OR ${connectionBrainErasures.closed} = 1))`
    )
    .groupBy(connectionBrainReads.connectionId)
    .orderBy(asc(connectionBrainReads.connectionId));
  return rows.map(({ connectionId, records, lastReadAt }) => ({
    connectionId,
    records,
    lastReadAt: new Date(lastReadAt),
  }));
};

/**
 * Which of the shared connections `connectionIds` the Brain may hold
 * something of: an audience chosen for it, or a record kept. What the
 * disconnect dialog says it erases by.
 */
export const mayHoldReadsOf = async (
  env: Pick<Env, "DB">,
  connectionIds: readonly string[]
): Promise<Set<string>> => {
  if (connectionIds.length === 0) {
    return new Set();
  }
  const db = drizzle(env.DB);
  const ids = [...connectionIds];
  const [audiences, reads] = await db.batch([
    db
      .select({ id: connectionBrainAudiences.connectionId })
      .from(connectionBrainAudiences)
      .where(inList(connectionBrainAudiences.connectionId, ids)),
    db
      .selectDistinct({ id: connectionBrainReads.connectionId })
      .from(connectionBrainReads)
      .where(inList(connectionBrainReads.connectionId, ids)),
  ]);
  return new Set([...audiences, ...reads].map(({ id }) => id));
};

/** Who asked for an erasure, and as which request: an audit event's id. */
interface ErasureRequest {
  connectionId: string;
  request: string;
  actor: AuditActor;
  at: Date;
}

/**
 * The statements that start the erasure `request` of what the Brain kept
 * through its connection, for one batch: its audience gone, and, unless
 * one is under way or this request started already, the next generation
 * marked under way. The statement after them sees whether it started
 * (`changes()`). A request started once never starts again, so a repeat
 * erases nothing kept after it ended.
 */
const startStatements = (
  db: DrizzleD1Database,
  { connectionId, request, actor, at }: ErasureRequest
) =>
  [
    db
      .delete(connectionBrainAudiences)
      .where(eq(connectionBrainAudiences.connectionId, connectionId)),
    db
      .insert(connectionBrainErasures)
      .values({
        connectionId,
        generation: 1,
        erasing: true,
        request,
        actor: JSON.stringify(actor),
        requestedAt: at,
        erased: 0,
        closed: false,
      })
      .onConflictDoUpdate({
        target: connectionBrainErasures.connectionId,
        set: {
          generation: sql`${connectionBrainErasures.generation} + 1`,
          erasing: true,
          request,
          actor: JSON.stringify(actor),
          requestedAt: at,
          erased: 0,
        },
        setWhere: sql`${connectionBrainErasures.erasing} = 0 AND ${connectionBrainErasures.request} <> ${request}`,
      }),
  ] as const;

/** The event that ends the erasure `row` served: by who asked, when they asked. */
const erasedEvent = async (row: {
  connectionId: string;
  request: string;
  actor: string;
  requestedAt: Date;
  erased: number;
}): Promise<AuditEvent> => ({
  ...createAuditEvent(
    {
      actor: auditActorSchema.parse(JSON.parse(row.actor)),
      action: "brain.shared_reads.erased",
      target: { type: "connection", id: row.connectionId },
      detail: { sources: row.erased },
    },
    "core"
  ),
  id: uuidFromHash(
    await sha256Hex(JSON.stringify(["brain.shared_reads.erased", row.request]))
  ),
  at: row.requestedAt.toISOString(),
});

/** The erasure a step took on: its connection, its request, and its generation. */
interface Stepping {
  connectionId: string;
  request: string;
  generation: number;
}

/** What one invocation may still spend on erasures: calls to the Brain's store. */
interface Budget {
  left: number;
}

/**
 * Ends the erasure `stepping` took on, whose older records (`older`) are
 * all erased, with its one event, in one batch: its count as the row has
 * it now, and only if it is still that erasure, under way, and no older
 * record was named since (none can be, while it is under way).
 */
const ended = async (
  env: Env,
  { connectionId, request, generation }: Stepping,
  older: SQL
): Promise<void> => {
  const db = drizzle(env.DB);
  // The erasure this step took on, and only while it is still under way:
  // never a newer one, whose own steps end it by its own records.
  const thisErasure = and(
    eq(connectionBrainErasures.connectionId, connectionId),
    eq(connectionBrainErasures.request, request),
    eq(connectionBrainErasures.generation, generation),
    eq(connectionBrainErasures.erasing, true)
  );
  const row = await db
    .select()
    .from(connectionBrainErasures)
    .where(thisErasure)
    .get();
  if (row === undefined) {
    return;
  }
  const event = await erasedEvent(row);
  await auditedBatch(env, db, [
    db
      .update(connectionBrainErasures)
      .set({ erasing: false })
      .where(
        and(
          thisErasure,
          sql`NOT EXISTS (SELECT 1 FROM ${connectionBrainReads} WHERE ${older})`
        )
      ),
    outboxedEventWhere(db, event, sql`changes() > 0`),
  ]);
};

/**
 * Takes the erasure under way of `connectionId`'s records a step on,
 * spending at most what `budget` has left (each call to the Brain's store
 * taken from it before it is made): keys of an older generation erased in
 * the Brain and forgotten here, a page at a time, and, once none is left,
 * the erasure ended with its one event, in one batch. Every read and
 * write after its first read is of the erasure it read then, by its
 * request and generation: should that one have ended meanwhile (another
 * step, at the same time) and a newer one started, this step changes
 * nothing of the newer one. Throws when the Brain or the database failed:
 * what was erased is forgotten, and the rest is erased by the next try,
 * which erases a key again without change.
 */
export const stepErasure = async (
  env: Env,
  connectionId: string,
  given?: Budget
): Promise<void> => {
  const budget = given ?? { left: brainCallsPerTick };
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(connectionBrainErasures)
    .where(
      and(
        eq(connectionBrainErasures.connectionId, connectionId),
        eq(connectionBrainErasures.erasing, true)
      )
    )
    .get();
  if (row === undefined) {
    return;
  }
  const stepping: Stepping = {
    connectionId,
    request: row.request,
    generation: row.generation,
  };
  const older = sql`${connectionBrainReads.connectionId} = ${connectionId} AND ${connectionBrainReads.generation} < ${row.generation}`;
  // Its erasure, still under way, as SQL for the statements that act.
  const stillThis = sql`EXISTS (SELECT 1 FROM ${connectionBrainErasures} WHERE ${connectionBrainErasures.connectionId} = ${connectionId} AND ${connectionBrainErasures.request} = ${row.request} AND ${connectionBrainErasures.generation} = ${row.generation} AND ${connectionBrainErasures.erasing} = 1)`;
  while (budget.left > 0) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const page = await db
      .select({ sourceId: connectionBrainReads.sourceId })
      .from(connectionBrainReads)
      .where(sql`${older} AND ${stillThis}`)
      .orderBy(asc(connectionBrainReads.sourceId))
      .limit(Math.min(erasedPerPage, budget.left));
    if (page.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- ends the loop
      await ended(env, stepping, older);
      return;
    }
    const ids = page.map(({ sourceId }) => sourceId);
    // Charged a round at a time, as `eraseSources` makes them (all of a
    // round's calls are made, even when one fails), so a step that fails
    // spends only the calls it made.
    for (let at = 0; at < ids.length; at += erasingAtOnce) {
      const round = ids.slice(at, at + erasingAtOnce);
      budget.left -= round.length;
      // oxlint-disable-next-line no-await-in-loop -- a round at a time
      await eraseSources(
        env,
        round.map((id) => ({
          source: { producer: "connected", id },
          readers: { kind: "connection", connectionId },
        })),
        "deleted"
      );
    }
    // Counted for its own erasure only, and only while it is under way:
    // a newer one counts its own records, these among them.
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    await db.batch([
      db
        .delete(connectionBrainReads)
        .where(
          sql`${inList(connectionBrainReads.sourceId, ids)} AND ${stillThis}`
        ),
      db
        .update(connectionBrainErasures)
        .set({ erased: sql`${connectionBrainErasures.erased} + changes()` })
        .where(
          and(
            eq(connectionBrainErasures.connectionId, connectionId),
            eq(connectionBrainErasures.request, row.request),
            eq(connectionBrainErasures.generation, row.generation),
            eq(connectionBrainErasures.erasing, true)
          )
        ),
    ]);
  }
};

/**
 * Takes every erasure under way a step on (`stepErasure`), oldest first,
 * all of them out of one `budget` of calls to the Brain's store for this
 * invocation (`brainCallsPerTick`): once it is spent, the rest wait for
 * the next run. One that fails is logged with its connection and its
 * error's name, and tried again at the clock's next run. The clock runs
 * it each minute.
 */
export const completeOwedErasures = async (
  env: Env,
  given?: Budget
): Promise<void> => {
  const budget = given ?? { left: brainCallsPerTick };
  const owed = await drizzle(env.DB)
    .select({ connectionId: connectionBrainErasures.connectionId })
    .from(connectionBrainErasures)
    .where(eq(connectionBrainErasures.erasing, true))
    .orderBy(asc(connectionBrainErasures.requestedAt));
  for (const { connectionId } of owed) {
    if (budget.left <= 0) {
      return;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await stepErasure(env, connectionId, budget);
    } catch (error) {
      log.warn("brain.shared_reads.erasure_owed", {
        connectionId,
        errorName: errorName(error),
      });
    }
  }
};

/**
 * Starts erasing everything the Brain kept of the shared connection a
 * disconnect stopped (connect's `connection.disconnect` event `request`,
 * by its actor, at its moment), and closes the connection here for good,
 * in one batch: for capture-erasures.ts, before connect's event leaves
 * its outbox. One under way already erases everything kept so far, and
 * none can be added meanwhile. A repeat of the same disconnect starts
 * nothing again. The clock does the erasing (`completeOwedErasures`).
 * Throws when the database failed: the disconnect is held for the next
 * drain.
 */
export const eraseSharedReadsOfDisconnect = async (
  env: Pick<Env, "DB">,
  request: ErasureRequest
): Promise<void> => {
  const db = drizzle(env.DB);
  await db.batch([
    ...startStatements(db, request),
    db
      .update(connectionBrainErasures)
      .set({ closed: true })
      .where(eq(connectionBrainErasures.connectionId, request.connectionId)),
  ]);
};

/**
 * Closes the shared connection `connectionId` for good as its disconnect
 * answers, by `actor`, in one batch: its audience goes, and it is marked
 * closed, so no audience change that passed connect's check before the
 * disconnect can write one after it (connection-audiences.ts), nor can
 * anything be kept under it. The erasure follows from connect's record of
 * the disconnect (`eraseSharedReadsOfDisconnect`), which starts it here.
 */
export const closeOnDisconnect = async (
  env: Pick<Env, "DB">,
  connectionId: string,
  actor: AuditActor
): Promise<void> => {
  const db = drizzle(env.DB);
  await db.batch([
    db
      .delete(connectionBrainAudiences)
      .where(eq(connectionBrainAudiences.connectionId, connectionId)),
    db
      .insert(connectionBrainErasures)
      .values({
        connectionId,
        generation: 0,
        erasing: false,
        // No erasure yet: the disconnect's own starts it.
        request: "",
        actor: JSON.stringify(actor),
        requestedAt: new Date(),
        erased: 0,
        closed: true,
      })
      .onConflictDoUpdate({
        target: connectionBrainErasures.connectionId,
        set: { closed: true },
      }),
  ]);
};

/**
 * An admin's "Erase what the Brain kept" of the shared connection
 * `connectionId`: everything, for good, its audience gone with it; what
 * agents read through it afterwards is kept only once an admin chooses an
 * audience again. Admins only, never Grasp staff. Its request is audited
 * in the batch that starts it (`brain.shared_reads.erase_requested`), and
 * its end once every record is erased (`brain.shared_reads.erased`, with
 * how many). Asking again while one is under way starts and records
 * nothing. Throws `connection.invalid` for a connection that isn't a
 * shared one connect knows.
 */
export const eraseBrainReads = async (
  env: Env,
  identity: Identity,
  connectionId: unknown
): Promise<void> => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const id = brainConnectionIdSchema.safeParse(connectionId);
  if (!id.success) {
    throw connectionErrors.create("connection.invalid");
  }
  const [owner] = await env.CONNECT.connectionOwners([id.data]);
  if (owner?.id !== id.data || owner.ownerUserId !== null) {
    throw connectionErrors.create("connection.invalid");
  }
  const actor = actorOf(identity);
  const requested = createAuditEvent(
    {
      actor,
      action: "brain.shared_reads.erase_requested",
      target: { type: "connection", id: id.data },
      detail: {},
    },
    "core"
  );
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    ...startStatements(db, {
      connectionId: id.data,
      request: requested.id,
      actor,
      at: new Date(requested.at),
    }),
    outboxedEventWhere(db, requested, sql`changes() > 0`),
  ]);
};
