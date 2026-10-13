import { isAppLayout } from "@grasp-os/compiler";
import type { App } from "@grasp-os/shared/apps";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sealRelease } from "./app-releases.ts";
import { requireAppTestsPass } from "./app-tests.ts";
import {
  appFor,
  findVersion,
  setCurrentVersion,
  versionFiles,
} from "./apps.ts";
import { createStore } from "./data-stores.ts";
import { appDefaultStores, businessStores } from "./db/core/schema.ts";

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
// - A version runs without its release, or on a store that is gone:
//   `setCurrentVersion` refuses a version of spec 8's layout whose release
//   isn't sealed, is revoked, or is bound to a deleted store, whoever calls
//   it, in the statement that makes it current. A deleted default store is
//   replaced by a new one for the versions sealed after it.

/** The App's default store, if it has one yet, and whether it still lives. */
const defaultStoreOf = async (
  env: Env,
  app: AppId
): Promise<{ store: StoreId; live: boolean } | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      store: appDefaultStores.storeId,
      deletedAt: businessStores.deletedAt,
      exists: businessStores.id,
    })
    .from(appDefaultStores)
    .leftJoin(businessStores, eq(businessStores.id, appDefaultStores.storeId))
    .where(eq(appDefaultStores.appId, app))
    .get();
  return row === undefined
    ? undefined
    : {
        store: storeIdSchema.parse(row.store),
        live: row.exists !== null && row.deletedAt === null,
      };
};

/**
 * The App's default store, created for `by` if it has none, or none that
 * still lives: a deleted default store is replaced by a new one, in one
 * conditional statement, so of two activations replacing it at once one
 * record wins and both use its store; the other store stays empty and
 * claimed by no App. The versions sealed on the deleted store stay bound
 * to it and are refused as they are made current (`setCurrentVersion`):
 * their data is gone, and a fresh store isn't it.
 */
const ensureDefaultStore = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<StoreId> => {
  const existing = await defaultStoreOf(env, app);
  if (existing?.live === true) {
    return existing.store;
  }
  const created = await createStore(env, by);
  const db = drizzle(env.DB);
  await (existing === undefined
    ? db
        .insert(appDefaultStores)
        .values({ appId: app, storeId: created, createdAt: new Date() })
        .onConflictDoNothing({ target: appDefaultStores.appId })
    : db
        .update(appDefaultStores)
        .set({ storeId: created, createdAt: new Date() })
        .where(
          and(
            eq(appDefaultStores.appId, app),
            eq(appDefaultStores.storeId, existing.store)
          )
        ));
  const recorded = await defaultStoreOf(env, app);
  if (recorded?.live !== true) {
    throw new Error("The App's default store wasn't recorded");
  }
  return recorded.store;
};

/** Whether `error` says the release needs a store it wasn't given. */
const needsStore = (error: unknown): boolean =>
  isExpectedError(error) && error.code === "version.store_unbound";

/**
 * Seals `version` of `app` when it is of spec 8's layout: on the App's
 * default store when it has one, and when the App's schema has tables
 * but no default store exists yet, on one created now. Answers the
 * version's files when it sealed it, nothing for another layout.
 */
const sealForActivation = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number
): Promise<Readonly<Record<string, string>> | undefined> => {
  const files = await versionFiles(env, app, version);
  if (!isAppLayout(files)) {
    return undefined;
  }
  const found = await defaultStoreOf(env, app);
  const store = found?.live === true ? found.store : undefined;
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
  return files;
};

/**
 * Makes `version` of `app` the one that runs, for one of its builders:
 * sealed first when it is of spec 8's layout (see the header), and only
 * once its App tests pass (app-tests.ts), on fixture stores of their own.
 */
export const activateVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<App> => {
  const found = await appFor(env, by, app, "builder");
  const { version: number } = await findVersion(env, found.id, version);
  const sealed = await sealForActivation(env, by, found.id, number);
  if (sealed !== undefined && found.currentVersion !== number) {
    await requireAppTestsPass(env, found.id, number, sealed);
  }
  return await setCurrentVersion(env, by, found.id, number);
};
