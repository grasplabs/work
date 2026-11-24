import type { StoreId } from "@grasp-os/shared/ids";

import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { appStoreFor } from "../src/data-stores.ts";

/**
 * The store of a new App `by` builds, made as its first seal makes it
 * (data-stores.ts, `appStoreFor`): for tests of the store itself.
 */
export const storeOfNewApp = async (env: Env, by: Acting): Promise<StoreId> => {
  const { id } = await createApp(env, by, { name: "Store" });
  return await appStoreFor(env, by, id);
};
