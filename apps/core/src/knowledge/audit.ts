import type { AuditEntry } from "@grasp-os/shared/audit";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { outboxed } from "../audit-outbox.ts";
import type { KnowledgePorts } from "./ports.ts";

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
  { audit }: Pick<KnowledgePorts, "audit">,
  db: DrizzleD1Database,
  statements: T
): Promise<BatchResponse<T>> => {
  const results = await db.batch(statements);
  audit.drain();
  return results;
};

/**
 * Stores the event for a change that has already happened outside a
 * batch, so the event can't join it, and drains it; if the database
 * refuses it, straight to the log; and if that fails too, in the logs (an
 * event is identifiers only). Never throws: the change is done, and
 * failing its caller wouldn't undo it.
 */
export const keepAuditEvent = async (
  { audit }: Pick<KnowledgePorts, "audit">,
  db: DrizzleD1Database,
  entry: AuditEntry
): Promise<void> => {
  try {
    await outboxed(db, entry);
  } catch (outboxError) {
    log.error("audit.outbox.store_failed", errorFields(outboxError));
    try {
      await audit.append(entry);
    } catch (appendError) {
      log.error("audit.lost", {
        ...errorFields(appendError),
        entry: canonicalJson(entry),
      });
    }
    return;
  }
  audit.drain();
};
