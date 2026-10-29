import { versionErrors } from "@grasp-os/shared/app-releases";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sdkStoreOwners } from "./db/core/schema.ts";

// A store's one canonical owner (spec 40.8, `sdk_store_owners`): an App,
// claimed by the first seal that binds the store, or an independent
// workflow (GRA-682), claimed when an admin activates a version that
// declares it. Threat model, and how each is closed:
// - A store coming to serve a second owner, which would read what the
//   first left behind: a claim is made once and kept for good, in one
//   statement that claims only where no claim exists, so of two owners
//   claiming a new store at once exactly one gets it, and every later
//   claim by anyone else is refused.
// - A workflow's store taken for an App's, or the other way round: the
//   row names exactly one kind of owner (a check constraint), and every
//   App lookup reads `app_id`, which a workflow's store never has. So a
//   workflow's store has no App to serve its operations, no App's grants
//   reach it, and no App seal can bind it.

/** Who owns a store: an App, or an independent workflow. */
export type StoreOwner =
  | { readonly kind: "app"; readonly id: AppId }
  | { readonly kind: "workflow"; readonly id: string };

/** `owner`'s columns, as a row names it: exactly one of the two. */
const columnsOf = (owner: StoreOwner) =>
  owner.kind === "app"
    ? { appId: owner.id, workflowId: null }
    : { appId: null, workflowId: owner.id };

/** Store `store`'s owner, if anyone claimed it. */
export const storeOwnerOf = async (
  env: Env,
  store: string
): Promise<StoreOwner | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      appId: sdkStoreOwners.appId,
      workflowId: sdkStoreOwners.workflowId,
    })
    .from(sdkStoreOwners)
    .where(eq(sdkStoreOwners.storeId, store))
    .get();
  if (row?.appId !== null && row?.appId !== undefined) {
    // SAFETY: only `claimStore` writes the column, from an `AppId`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return { kind: "app", id: row.appId as AppId };
  }
  return row?.workflowId === null || row?.workflowId === undefined
    ? undefined
    : { kind: "workflow", id: row.workflowId };
};

/** Whether `a` and `b` are the same owner. */
const sameOwner = (a: StoreOwner | undefined, b: StoreOwner): boolean =>
  a?.kind === b.kind && a.id === b.id;

/** Whether `store` is claimed for `owner`. */
export const claimedFor = async (
  env: Env,
  store: string | undefined,
  owner: StoreOwner
): Promise<boolean> =>
  store !== undefined && sameOwner(await storeOwnerOf(env, store), owner);

/**
 * Claims `store` for `owner` for good, or refuses
 * (`version.store_bound_elsewhere`) a store anyone else claimed: one
 * statement claims it only where no claim exists, so of two owners
 * claiming a new store at once, exactly one gets it.
 */
export const claimStore = async (
  env: Env,
  store: StoreId,
  owner: StoreOwner
): Promise<void> => {
  await drizzle(env.DB)
    .insert(sdkStoreOwners)
    .values({ storeId: store, ...columnsOf(owner), claimedAt: new Date() })
    .onConflictDoNothing();
  if (!(await claimedFor(env, store, owner))) {
    throw versionErrors.create("version.store_bound_elsewhere");
  }
};
