import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { storeIdSchema } from "@grasp-os/shared/ids";
import { migrationErrors } from "@grasp-os/shared/stores";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sdkResourceBindings } from "./db/core/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import type { SchemaStatus } from "./store-host.ts";

// A store's schema change and the release that brought it (spec 17.4
// steps 5 and 6): a store takes a schema whose defaulted fields its
// records lack as a pending target, and its contract moves to it only once
// its backfill has filled them all in (store-host.ts, `fillMissing`). A
// release sealed on that schema is sealed, but runs on the store only once
// the store's contract holds its schema: core asks the store, the
// authority on its own contract, before it makes such a release current.
// A contract only ever widens, so a release found in force stays so, and
// nothing between the question and the change can undo the answer.

/** The store `storeId`'s object, for core's own questions of it. */
const storeObject = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId
) => inJurisdiction(env, env.DATA_STORES).getByName(storeId);

/** Whether the store holds `schemaHash` in force (`StoreHost.schemaStatus`). */
export const schemaStatus = async (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId,
  schemaHash: string
): Promise<SchemaStatus> =>
  await storeObject(env, storeId).schemaStatus(storeId, schemaHash);

/**
 * Refuses release `version` of `app` while the store it binds doesn't
 * hold its schema in force: `migration.pending` (retryable, with the
 * backfill's progress) while its defaulted fields are being filled in,
 * `migration.backfill_failed` (naming the record) once that failed. A
 * release without a store passes.
 */
export const requireStoreSchemaActive = async (
  env: Env,
  app: AppId,
  version: number
): Promise<void> => {
  const bound = await drizzle(env.DB)
    .select({
      store: sdkResourceBindings.targetId,
      schemaHash: sdkResourceBindings.schemaHash,
    })
    .from(sdkResourceBindings)
    .where(
      and(
        eq(sdkResourceBindings.resourceId, app),
        eq(sdkResourceBindings.resourceVersion, version),
        eq(sdkResourceBindings.kind, "store")
      )
    )
    .get();
  if (bound === undefined) {
    return;
  }
  const status = await schemaStatus(
    env,
    storeIdSchema.parse(bound.store),
    bound.schemaHash
  );
  if (status.state === "active") {
    return;
  }
  if (status.state === "pending") {
    throw migrationErrors.create("migration.pending", {
      retryable: true,
      scanned: status.scanned,
      filled: status.filled,
    });
  }
  if (status.state === "failed") {
    throw migrationErrors.create("migration.backfill_failed", {
      failure: status.failure === null ? null : { ...status.failure },
    });
  }
  // A sealed release's schema the store never took: its records and
  // core's disagree, which no retry mends.
  throw new Error(
    "The store doesn't hold the schema its release was sealed on"
  );
};
