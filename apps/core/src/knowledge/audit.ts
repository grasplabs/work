import type { BrainEvent } from "@grasp-os/brain/events";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditOutbox } from "../db/knowledge/schema.ts";
import type { Brain, BrainPorts } from "./brain.ts";

// Knowledge's audit events: each is stored in Knowledge's own outbox in
// the batch of the change it records (`outboxed`, `outboxedWhere`), so
// nothing changes unrecorded, and the host's `audit` port drains the
// outbox into its log.

/**
 * Runs an audited change: `statements` (the change and its `outboxed`
 * events) in one batch, then has the host drain the outbox. A batch that
 * fails stores and drains nothing.
 */
export const auditedBatch = async <
  U extends BatchItem<"sqlite">,
  T extends Readonly<[U, ...U[]]>,
>(
  { audit }: Pick<BrainPorts<never>, "audit">,
  db: DrizzleD1Database,
  statements: T
): Promise<BatchResponse<T>> => {
  const results = await db.batch(statements);
  audit.drain();
  return results;
};

/**
 * Stores the event for `entry`, as the host's `audit.eventOf` port makes
 * it, only if `condition` holds when the statement runs, in the batch it
 * runs in: so what the batch's earlier statements wrote decides it, and no
 * concurrent change can come between.
 */
export const outboxedWhere = <C>(
  { db, ports }: Brain<C>,
  entry: BrainEvent,
  condition: SQL
) => {
  const { id, event } = ports.audit.eventOf(entry);
  return db
    .insert(auditOutbox)
    .select(
      sql`SELECT ${id}, ${event}, ${ports.clock().getTime()} WHERE ${condition}`
    );
};

/** Stores the event for `entry`; run it in one batch with the change. */
export const outboxed = <C>(brain: Brain<C>, entry: BrainEvent) =>
  outboxedWhere(brain, entry, sql`1`);

/**
 * Stores the event for `entry` only if the batch's previous statement
 * changed a row, so a conditional update that changed nothing records
 * nothing. Not after statements that write sections (see core's
 * audit-outbox.ts `outboxedIfChanged`): FTS5's flush sets `changes()`.
 */
export const outboxedIfChanged = <C>(brain: Brain<C>, entry: BrainEvent) =>
  outboxedWhere(brain, entry, sql`changes() > 0`);
