import { versionErrors } from "@grasp-os/shared/app-releases";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sdkStoreOwners } from "./db/core/schema.ts";

// A store's one canonical owner (spec 40.8, `sdk_store_owners`): the App
// whose first seal binds the store. Threat model, and how it is closed:
// - A store coming to serve a second App, which would read what the first
//   left behind: a claim is made once and kept for good, in one statement
//   that claims only where no claim exists, so of two Apps claiming a new
//   store at once exactly one gets it, and every later claim by another
//   App is refused.

/** The App that owns store `store`, if one claimed it. */
export const storeOwnerOf = async (
  env: Env,
  store: string
): Promise<AppId | undefined> => {
  const row = await drizzle(env.DB)
    .select({ appId: sdkStoreOwners.appId })
    .from(sdkStoreOwners)
    .where(eq(sdkStoreOwners.storeId, store))
    .get();
  // SAFETY: only `claimStore` writes the column, from an `AppId`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return row?.appId as AppId | undefined;
};

/** Whether `store` is claimed for App `app`. */
export const claimedFor = async (
  env: Env,
  store: string | undefined,
  app: AppId
): Promise<boolean> =>
  store !== undefined && (await storeOwnerOf(env, store)) === app;

/**
 * Claims `store` for App `app` for good, or refuses
 * (`version.store_bound_elsewhere`) a store another App claimed: one
 * statement claims it only where no claim exists, so of two Apps claiming
 * a new store at once, exactly one gets it.
 */
export const claimStore = async (
  env: Env,
  store: StoreId,
  app: AppId
): Promise<void> => {
  await drizzle(env.DB)
    .insert(sdkStoreOwners)
    .values({ storeId: store, appId: app, claimedAt: new Date() })
    .onConflictDoNothing();
  if (!(await claimedFor(env, store, app))) {
    throw versionErrors.create("version.store_bound_elsewhere");
  }
};
