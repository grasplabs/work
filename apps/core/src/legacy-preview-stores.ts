import { storeIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { discardFixtureStore } from "./data-stores.ts";
import { previewFixtureStores } from "./db/core/schema.ts";

// CONTRACT: delete this module, its clock entry, its call in members.ts
// and `preview_fixture_stores` in `DataStore.discardFixture` with the
// release that drops the `preview_fixture_stores` table.
//
// The fixture stores chats' previews ran on before a preview ran on a
// throwaway store that empties itself (draft-runs.ts). Nothing runs on
// them any more, and none ever had an expiry of its own, so what someone
// typed into one would stay: core discards every one it recorded, a page
// at a time from the clock, and a removed person's at once (members.ts),
// which their erasure follows. Each store's object first
// (`DataStore.discardFixture`, which refuses a store core didn't record
// as a fixture, or that its inventory lists), then core's row, so a
// discard that fails is found again.

/** Most stores one run discards. */
const storesPerRun = 50;

/**
 * Discards up to `storesPerRun` of the recorded preview stores, of
 * `personId`'s chats when given. Never throws: a store whose discard
 * failed keeps its row, for the next run.
 */
export const discardLegacyPreviewStores = async (
  env: Env,
  personId?: string
): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    const stores = await db
      .select({ storeId: previewFixtureStores.storeId })
      .from(previewFixtureStores)
      .where(
        personId === undefined
          ? undefined
          : eq(previewFixtureStores.personId, personId)
      )
      .limit(storesPerRun);
    for (const { storeId } of stores) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        await discardFixtureStore(env, storeIdSchema.parse(storeId));
        // oxlint-disable-next-line no-await-in-loop -- its row once it went
        await db
          .delete(previewFixtureStores)
          .where(eq(previewFixtureStores.storeId, storeId));
      } catch (error) {
        log.warn("preview.legacy_store_discard_failed", {
          store: storeId,
          ...errorFields(error),
        });
      }
    }
  } catch (error) {
    log.warn("preview.legacy_store_discard_failed", errorFields(error));
  }
};

/** `discardLegacyPreviewStores` for the clock, every recorded store's. */
export const sweepLegacyPreviewStores = async (env: Env): Promise<void> => {
  await discardLegacyPreviewStores(env);
};
