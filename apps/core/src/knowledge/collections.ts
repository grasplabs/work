import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { and, asc, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { outboxedIfChanged } from "../audit-outbox.ts";
import { collections } from "../db/knowledge/schema.ts";
import { auditedBatch } from "./audit.ts";
import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";

export type CollectionRow = typeof collections.$inferSelect;

/** The collections `reader` may read, by name. */
export const readableCollections = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<CollectionRow[]> => {
  const { collections: allowed } = await allowedFor(brain.ports, reader);
  return await brain.db
    .select()
    .from(collections)
    .where(allowed)
    .orderBy(asc(collections.name), asc(collections.id));
};

/** The collection, if it is one of the `allowed` collections. */
export const readableCollection = async (
  db: DrizzleD1Database,
  allowed: SQL,
  collectionId: unknown
): Promise<CollectionRow> => {
  const id = collectionIdSchema.safeParse(collectionId);
  const row = id.success
    ? await db
        .select()
        .from(collections)
        .where(and(eq(collections.id, id.data), allowed))
        .get()
    : undefined;
  if (!row) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return row;
};

/**
 * Creates the collection `row`, one the platform names (memory's), by
 * `actor`, unless one with its ID exists already; audited, with `detail`,
 * only when it created it. Returns the collection under that ID, which is
 * `row` unless it existed.
 */
export const ensureCollection = async <C>(
  brain: Brain<C>,
  row: CollectionRow,
  actor: AuditActor,
  detail: Record<string, AuditDetailValue> = {}
): Promise<CollectionRow> => {
  const { db } = brain;
  const { access, sensitive, source } = row;
  await auditedBatch(brain.ports, db, [
    db.insert(collections).values(row).onConflictDoNothing(),
    outboxedIfChanged(db, {
      actor,
      action: "knowledge.collection.created",
      target: { type: "collection", id: row.id },
      detail: { ...detail, access, sensitive, source },
    }),
  ]);
  const found = await db
    .select()
    .from(collections)
    .where(eq(collections.id, row.id))
    .get();
  if (!found) {
    throw new Error(`Collection ${row.id} is missing after creating it`);
  }
  return found;
};
