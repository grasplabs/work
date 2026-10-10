import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { StoreId } from "@grasp-os/shared/ids";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  auditedBatch,
  outboxedEventWhere,
  uuidFromHash,
} from "./audit-outbox.ts";
import { businessStores } from "./db/core/schema.ts";

// Recording a store's deletion in core's inventory: its row marked deleted
// and its `store.deleted` event, in one batch. Core runs it as it deletes
// the store (data-stores.ts), and the store's object runs it again before
// it purges a single record (store-host.ts), until it succeeds, so no
// store is destroyed unaudited, even if core's call stopped after the
// object was marked. The event is made from the object's mark alone (who
// deleted it, and when), with an ID derived from the store's, so both
// make the same event; only the batch that marks the row stores it, so it
// is stored once whichever runs first, and an event delivered twice is
// the same event, which the audit log takes once.

/** The `store.deleted` event of `store`, the same wherever it is made. */
export const storeDeletedEvent = async (
  store: StoreId,
  actor: AuditActor,
  deletedAt: number
): Promise<AuditEvent> =>
  auditEventSchema.parse({
    actor,
    action: "store.deleted",
    target: { type: "store", id: store },
    detail: {},
    id: uuidFromHash(await sha256Hex(`store.deleted:${store}`)),
    at: new Date(deletedAt).toISOString(),
    source: "core",
  });

/**
 * Marks `store`'s inventory row deleted at `deletedAt`, and stores its
 * `store.deleted` event in the same batch, unless the row was marked
 * already: repeating it changes nothing.
 */
export const recordStoreDeleted = async (
  env: Env,
  store: StoreId,
  actor: AuditActor,
  deletedAt: number
): Promise<void> => {
  const db = drizzle(env.DB);
  const event = await storeDeletedEvent(store, actor, deletedAt);
  await auditedBatch(env, db, [
    db
      .update(businessStores)
      .set({ deletedAt: new Date(deletedAt) })
      .where(
        and(eq(businessStores.id, store), isNull(businessStores.deletedAt))
      ),
    // A deterministic event (above), which `outboxedIfChanged` can't make.
    outboxedEventWhere(db, event, sql`changes() > 0`),
  ]);
};
