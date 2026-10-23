import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";

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
