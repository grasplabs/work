import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { dataErrors } from "@grasp-os/shared/stores";
import type {
  ClaimInput,
  Claimed,
  Commit,
  Committed,
  StoredRecord,
} from "@grasp-os/shared/stores";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { businessStores } from "./db/core/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";

// The deployment's business stores, as core finds them: its inventory in
// core D1 (`business_stores`) says which stores exist, and each store's
// records live in its own Durable Object (data-store.ts), named by the
// store's ID. Core D1 never holds a store's records. A store's ID is
// minted here, at random: it isn't an App's, a workflow's or a run's, and
// no name anyone gives a store becomes it, so a store outlives whatever
// first used it, and nothing reaches it by guessing a name.

/** A store, as core uses it: its ID bound to every call. */
export interface OpenStore {
  id: StoreId;
  defineTables: (names: readonly string[]) => Promise<Record<string, string>>;
  get: (table: string, id: string) => Promise<StoredRecord | null>;
  claim: (claim: Omit<ClaimInput, "storeId">) => Promise<Claimed>;
  commit: (commit: Omit<Commit, "storeId">) => Promise<Committed>;
}

/**
 * Adds a new store to the inventory, owned by `ownerId`, and answers its
 * ID. Its object starts empty on first use.
 */
export const createStore = async (
  env: Pick<Env, "DB">,
  ownerId: string
): Promise<StoreId> => {
  const id = storeIdSchema.parse(crypto.randomUUID());
  await drizzle(env.DB)
    .insert(businessStores)
    .values({
      id,
      ownerId,
      physicalNamespaceRole: "data_store",
      createdAt: new Date(),
    })
    .run();
  return id;
};

/**
 * The store `id`, if the inventory lists it and it isn't deleted;
 * otherwise `data.store_unavailable`, the same for a store that never
 * existed as for a deleted one.
 */
export const openStore = async (
  env: Pick<Env, "DB" | "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  id: string
): Promise<OpenStore> => {
  const parsed = storeIdSchema.safeParse(id);
  const row = parsed.success
    ? await drizzle(env.DB)
        .select({ id: businessStores.id })
        .from(businessStores)
        .where(
          and(
            eq(businessStores.id, parsed.data),
            isNull(businessStores.deletedAt)
          )
        )
        .get()
    : undefined;
  if (!parsed.success || row === undefined) {
    throw dataErrors.create("data.store_unavailable");
  }
  const storeId = parsed.data;
  const stub = inJurisdiction(env, env.DATA_STORES).getByName(storeId);
  return {
    id: storeId,
    defineTables: async (names) => await stub.defineTables(storeId, names),
    get: async (table, recordId) => await stub.get(storeId, table, recordId),
    claim: async (claim) => await stub.claim({ ...claim, storeId }),
    commit: async (commit) => await stub.commit({ ...commit, storeId }),
  };
};
