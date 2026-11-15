import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { appIdSchema } from "@grasp-os/shared/ids";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { keepEvent, uuidFromHash } from "./audit-outbox.ts";
import { eraseWriter } from "./brain-next.ts";
import { appDefaultStores } from "./db/core/schema.ts";

// What an App's code remembered goes with its data (GRA-1883, threat
// model on the issue): deleting the App's store or resetting its data
// erases every memory written as `app:<id>` (brain-app-writes.ts), in the
// same step and first, so a step cut off leaves data without memories,
// never memories without data. The Brain's `eraseWriter` records it in
// its ledger, so no restore of an older copy or of an export brings them
// back, and answers the same for the same change, erasing nothing more:
//
// - A store's deletion is one change (`app-store-deleted:<store>`, a
//   store's id is never minted again), erased before core's inventory
//   marks the store deleted (store-deletion.ts), which the store's alarm
//   repeats until it lands: so the deletion never reads as done before
//   the memories are gone.
// - A reset is one change a request, minted as it starts
//   (data-stores.ts `resetAppStore`), erased before the store resets.
//
// One audit event an erasure, by ids and the count it covered, its ID
// from the change and its time the one the Brain recorded, so a repeat
// keeps the same event. What the App remembers afterwards is new, and
// kept: the Brain never closes a writer.

/** Why an App's memories are erased, as its audit event says. */
type Cause = "store_deleted" | "data_reset";

/**
 * `erase` once, and once more when its reply was lost (an error no rule
 * of the Brain's gave): the same change, so it answers what landed.
 */
const landed = async <T>(erase: () => Promise<T>): Promise<T> => {
  try {
    return await erase();
  } catch (error) {
    if (isExpectedError(error)) {
      throw error;
    }
    return await erase();
  }
};

/**
 * Erases every memory App `app`'s code wrote, under `change` (the same on
 * every retry of one deletion or one reset), and keeps its one audit event
 * for `actor`. Throws while the Brain hasn't recorded it: the caller's
 * retry, with the same change, finishes it.
 */
export const eraseAppMemories = async (
  env: Env,
  {
    app,
    change,
    actor,
    cause,
  }: { app: AppId; change: string; actor: AuditActor; cause: Cause }
): Promise<void> => {
  const { erasedAt, memories } = await landed(
    async () =>
      await eraseWriter(env, {
        writer: `app:${appIdSchema.parse(app)}`,
        reason: "deleted",
        change,
      })
  );
  const action = "brain.memory.erased";
  await keepEvent(
    env,
    drizzle(env.DB),
    auditEventSchema.parse({
      actor,
      action,
      target: { type: "app", id: app },
      detail: { cause, memories },
      id: uuidFromHash(await sha256Hex(JSON.stringify([action, change]))),
      at: erasedAt.toISOString(),
      source: "core",
    })
  );
};

/**
 * Erases what the App whose store `store` is remembered, as its deletion
 * by `actor` (store-deletion.ts): one change for the store. Nothing for a
 * store no App holds.
 */
export const eraseDeletedStoresMemories = async (
  env: Env,
  store: StoreId,
  actor: AuditActor
): Promise<void> => {
  // Still the App's while core's inventory hasn't marked the store
  // deleted: a store that replaces it is minted only after that.
  const row = await drizzle(env.DB)
    .select({ app: appDefaultStores.appId })
    .from(appDefaultStores)
    .where(eq(appDefaultStores.storeId, store))
    .get();
  if (row === undefined) {
    return;
  }
  await eraseAppMemories(env, {
    app: appIdSchema.parse(row.app),
    change: `app-store-deleted:${store}`,
    actor,
    cause: "store_deleted",
  });
};
