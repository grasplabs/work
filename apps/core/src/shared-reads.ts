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
import { waitUntil } from "cloudflare:workers";
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
import { eraseSources } from "./brain-next-origins.ts";
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
// A started erasure is owed until then: tried at once, and again by the
// clock each minute (`completeOwedErasures`), so a Worker that stopped
// part-way, or a store out of reach, delays it and never drops it.

/** A record's key under its connection: its generation, then a hash. */
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * How many calls to the Brain's store one invocation spends on erasures
 * at most, one a record: 400 of Workers' bound of 1,000 subrequests an
 * invocation, leaving 600 for the clock's other tasks that run in the same
 * one (the audit drain, the Brain's work queue and hand-overs, the
 * onboarding's and the uploads' owed work, each a few dozen calls a
 * tick), or for the request a step at once runs in. Every erasure under
 * way shares it (`completeOwedErasures`); what is left is erased by the
 * next tick, so any number is erased in the end.
 */
export const brainCallsPerTick = 400;

/** A page of keys erased and forgotten in one go. */
const erasedPerPage = 100;

/**
 * Names a record the Brain is to keep of what an agent read through the
 * shared connection `connectionId`, the call or item its producer hashed
 * as `hash` (a SHA-256 in hex), and answers the source to add it as, in
 * the connection's current generation: or nothing when no audience is
 * chosen for it now. An erasure under way never has one: it takes the
 * audience away as it starts, and none can be chosen until it ends
 * (connection-audiences.ts). Decided in the statement that names it, so
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
        WHERE EXISTS (SELECT 1 FROM ${connectionBrainAudiences} WHERE ${connectionBrainAudiences.connectionId} = ${connection})`
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

/** Whether anything of `connectionId` is kept or may be: an audience, or a record. */
const holdsAny = async (
  db: DrizzleD1Database,
  connectionId: string
): Promise<boolean> => {
  const [audience, read] = await Promise.all([
    db
      .select({ id: connectionBrainAudiences.connectionId })
      .from(connectionBrainAudiences)
      .where(eq(connectionBrainAudiences.connectionId, connectionId))
      .get(),
    db
      .select({ id: connectionBrainReads.sourceId })
      .from(connectionBrainReads)
      .where(eq(connectionBrainReads.connectionId, connectionId))
      .limit(1)
      .get(),
  ]);
  return audience !== undefined || read !== undefined;
};

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
    budget.left -= ids.length;
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    await eraseSources(
      env,
      ids.map((id) => ({
        source: { producer: "connected", id },
        readers: { kind: "connection", connectionId },
      })),
      "deleted"
    );
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

/** Takes the erasure of `connectionId` on now, in the background; the clock finishes what this doesn't. */
const stepSoon = (env: Env, connectionId: string): void => {
  const step = async (): Promise<void> => {
    try {
      await stepErasure(env, connectionId);
    } catch (error) {
      log.warn("brain.shared_reads.erasure_owed", {
        connectionId,
        errorName: errorName(error),
      });
    }
  };
  waitUntil(step());
};

/**
 * Starts erasing everything the Brain kept of the shared connection a
 * disconnect stopped (connect's `connection.disconnect` event `request`,
 * by its actor, at its moment), when anything of it is kept or may be:
 * for capture-erasures.ts, before connect's event leaves its outbox. A
 * repeat of the same disconnect starts nothing again. Throws when the
 * database failed: the disconnect is held for the next drain.
 */
export const eraseSharedReadsOfDisconnect = async (
  env: Env,
  request: ErasureRequest
): Promise<void> => {
  const db = drizzle(env.DB);
  if (!(await holdsAny(db, request.connectionId))) {
    return;
  }
  await db.batch([...startStatements(db, request)]);
  stepSoon(env, request.connectionId);
};

/**
 * Stops anyone reading what the Brain kept of the shared connection
 * `connectionId` at once, as its disconnect returns: its audience goes.
 * The erasure follows from connect's record of the disconnect.
 */
export const forgetAudienceOf = async (
  env: Pick<Env, "DB">,
  connectionId: string
): Promise<void> => {
  await drizzle(env.DB)
    .delete(connectionBrainAudiences)
    .where(eq(connectionBrainAudiences.connectionId, connectionId));
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
  stepSoon(env, id.data);
};
