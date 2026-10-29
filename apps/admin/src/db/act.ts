/**
 * How the admin changes anything: the change and its audit event in one
 * D1 batch, so neither lands without the other (threat model R19, CO6). A
 * change outside the database (a run started) is recorded first, on
 * its own (`audit`).
 */
import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { Staff } from "../access.ts";
import { auditEvents } from "./schema.ts";

export type AdminDatabase = DrizzleD1Database;

/** The admin's database, through Drizzle. */
export const adminDatabase = (d1: D1Database): AdminDatabase => drizzle(d1);

/** Who acted: a staff member, or the admin itself (its cron and workflows). */
export type Actor = Staff | "system";

/**
 * Who an audit event names: an actor, or a Discord user asking Grasp's bot
 * (src/admin/discord.ts), by their Discord id. The bot only reads, so it is
 * only ever recorded on its own (`audit`).
 */
export type AuditActor = Actor | `discord:${string}`;

/** What happened, as the audit log records it: identifiers, never content. */
export interface AdminEvent {
  /** A dotted verb, such as `client.create`. */
  action: string;
  /** The client it concerns, if any. */
  clientId?: string;
  /** What it acted on within that client, such as a release or rollout id. */
  target?: string;
  /** Identifiers and counts only; never secrets, tokens or response bodies. */
  detail?: Record<string, string | number | boolean>;
}

/** A dotted verb: at least two lowercase segments, as in core's audit log. */
const actionPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/** Checks `event` and builds its row. */
const rowOf = (actor: AuditActor, event: AdminEvent) => {
  if (!actionPattern.test(event.action)) {
    throw new Error(`Not an audit action: ${event.action}`);
  }
  return {
    id: crypto.randomUUID(),
    at: new Date(),
    actor: typeof actor === "string" ? actor : actor.email,
    action: event.action,
    clientId: event.clientId ?? null,
    target: event.target ?? null,
    detail: event.detail === undefined ? null : JSON.stringify(event.detail),
  };
};

/**
 * Runs `statements`, at least one, and records `event` by `actor` in one
 * batch (one transaction): if any statement fails, nothing is written, the
 * event included. For changes that always happen when their statements
 * succeed; a conditional one goes through `actIfChanged`.
 */
export const act = async (
  db: AdminDatabase,
  actor: Actor,
  statements: readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  event: AdminEvent
): Promise<void> => {
  const record = db.insert(auditEvents).values(rowOf(actor, event));
  // One batch is one transaction, so where the event sits in it doesn't
  // matter. (`actIfChanged` is different: its event must follow the
  // statement whose changes it reads.)
  await db.batch([record, ...statements]);
};

/**
 * Records `event` by `actor` on its own: for an action whose change isn't
 * in the admin's database, such as starting a run. Recorded before
 * the action, so an action that then fails is still an audited attempt.
 */
export const audit = async (
  db: AdminDatabase,
  actor: AuditActor,
  event: AdminEvent
): Promise<void> => {
  await db.insert(auditEvents).values(rowOf(actor, event));
};

/**
 * Runs `statement`, a conditional change (an update or delete with a
 * `WHERE` that may match nothing, or an insert that ignores a conflict,
 * as the release import's), and records `event` by `actor` only if
 * it changed a row, in the same batch. Returns whether it did, read from
 * the batch's own results: nothing runs after the batch commits.
 * `following` runs after the event in the same batch: statements whose
 * own `WHERE` makes them depend on the change, such as rows that
 * reference one it inserted.
 *
 * The event's insert comes right after the statement and reads its
 * `changes()`. That's sound in the admin's database, which has no FTS
 * tables: an FTS5 index flush sets `changes()` too (see core's
 * `outboxedIfChanged`), so this must not be used where one could run.
 */
export const actIfChanged = async (
  db: AdminDatabase,
  actor: Actor,
  statement: BatchItem<"sqlite">,
  event: AdminEvent,
  following: readonly BatchItem<"sqlite">[] = []
): Promise<boolean> => {
  const row = rowOf(actor, event);
  const record = db
    .insert(auditEvents)
    .select(
      sql`SELECT ${row.id}, ${row.at.getTime()}, ${row.actor}, ${row.action}, ${row.clientId}, ${row.target}, ${row.detail} WHERE changes() > 0`
    )
    .returning({ id: auditEvents.id });
  const [, recorded] = await db.batch([statement, record, ...following]);
  return recorded.length > 0;
};
