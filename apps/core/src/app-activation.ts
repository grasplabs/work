import { isAppLayout } from "@grasp-os/compiler";
import type { App } from "@grasp-os/shared/apps";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sealRelease } from "./app-releases.ts";
import {
  appFor,
  findVersion,
  setCurrentVersion,
  versionFiles,
} from "./apps.ts";
import { createStore } from "./data-stores.ts";
import { appDefaultStores } from "./db/core/schema.ts";

// Making a version of an App current (spec 8, 16): a version of spec 8's
// layout runs only from its sealed release, so it is sealed first, on the
// App's default store, and only then made current. Threat model, and how
// each is closed:
//
// - An activation binds a store another App's data is in: no request names
//   a store. The App's one default store is the host's record
//   (`app_default_stores`), created here the first time a version needs
//   one; sealing then claims it for the App for good (`sdk_store_owners`),
//   so a store can't serve two Apps whatever this record says.
// - Someone without the right binds or creates a store: only the App's
//   builders activate (`appFor … "builder"`), and the store a first
//   activation creates is theirs, as `createStore` records it. Who else
//   manages an App's store is GRA-416's.
// - A version runs without its release: `setCurrentVersion` refuses a
//   version of spec 8's layout that isn't sealed, whoever calls it.

/** The App's default store, if it has one yet. */
const defaultStoreOf = async (
  env: Env,
  app: AppId
): Promise<StoreId | undefined> => {
  const row = await drizzle(env.DB)
    .select({ store: appDefaultStores.storeId })
    .from(appDefaultStores)
    .where(eq(appDefaultStores.appId, app))
    .get();
  return row === undefined ? undefined : storeIdSchema.parse(row.store);
};

/**
 * The App's default store, created for `by` if it has none. Of two first
 * activations at once, one record wins and both use its store; the other
 * store stays empty and claimed by no App.
 */
const ensureDefaultStore = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<StoreId> => {
  const existing = await defaultStoreOf(env, app);
  if (existing !== undefined) {
    return existing;
  }
  const created = await createStore(env, by);
  await drizzle(env.DB)
    .insert(appDefaultStores)
    .values({ appId: app, storeId: created, createdAt: new Date() })
    .onConflictDoNothing({ target: appDefaultStores.appId });
  const store = await defaultStoreOf(env, app);
  if (store === undefined) {
    throw new Error("The App's default store wasn't recorded");
  }
  return store;
};

/** Whether `error` says the release needs a store it wasn't given. */
const needsStore = (error: unknown): boolean =>
  isExpectedError(error) && error.code === "version.store_unbound";

/**
 * Seals `version` of `app` when it is of spec 8's layout: on the App's
 * default store when it has one, and when the App's schema has tables
 * but no default store exists yet, on one created now.
 */
const sealForActivation = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number
): Promise<void> => {
  const files = await versionFiles(env, app, version);
  if (!isAppLayout(files)) {
    return;
  }
  const store = await defaultStoreOf(env, app);
  try {
    await sealRelease(env, { app, version, store, by });
  } catch (error) {
    if (store !== undefined || !needsStore(error)) {
      throw error;
    }
    await sealRelease(env, {
      app,
      version,
      store: await ensureDefaultStore(env, by, app),
      by,
    });
  }
};

/**
 * Makes `version` of `app` the one that runs, for one of its builders:
 * sealed first when it is of spec 8's layout (see the header).
 */
export const activateVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<App> => {
  const found = await appFor(env, by, app, "builder");
  const { version: number } = await findVersion(env, found.id, version);
  await sealForActivation(env, by, found.id, number);
  return await setCurrentVersion(env, by, found.id, number);
};
