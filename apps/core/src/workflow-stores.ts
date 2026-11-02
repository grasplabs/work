import type { SealedStore } from "@grasp-os/open-workflow/stores";
import { manifestText } from "@grasp-os/sdk/host";
import { actorOf } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { requireBuilder } from "@grasp-os/shared/roles";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { openStore } from "./data-stores.ts";
import {
  businessStores,
  businessStoreVersions,
  sdkResourceBindings,
  sdkStoreOwners,
  workflowStores,
} from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import { requireNotStaff } from "./sharing.ts";
import { defineSchemaOnStore } from "./store-backfill.ts";
import { liveStoreSql } from "./store-deletion.ts";
import { storeAlias } from "./workflow-store-host.ts";

// The stores a standalone workflow declares (GRA-682): created and handed
// their schema when a version declaring them is published, the workflow's
// own freeze, verify and activate flow (workflow-resources.ts, `publish`),
// and bound to that version in the batch that makes it current. A run, a
// test run or a draft never reaches this; serving a store's generated
// operations to consumers is store-operations.ts's (slice 4), and until
// then no one reaches a workflow's store.
//
// Threat model, and how each is closed:
//
// - A store created without authority: only a publication creates one,
//   which needs the workflow's builder role (`requireWorkflowRole`), and
//   here an organization role that builds (as creating any store does)
//   and never Grasp staff (whom a client's data reaches is the client's
//   decision, as for binding a store to an App).
// - A crash or a retry minting a second store for one name: a store is
//   created in one audited batch with its `workflow_stores` row (keyed by
//   workflow and name) and its `sdk_store_owners` claim of kind
//   `workflow`, so either all of it is written or none, and a publication
//   run again (or a racing one) finds the store by its name and reuses it.
// - A workflow reaching another owner's store: it only ever reaches the
//   store its own `workflow_stores` row names, and the version's binding
//   lands only while the workflow still owns that store and it is live
//   and not being deleted (`boundStoreSql`), otherwise the publication
//   fails whole.
// - A schema that breaks the store's records: the store's object applies
//   only safe changes (store-host.ts, `defineTables`) and refuses one that
//   needs a migration (`migration.required`), before the version is
//   written; a schema it applied for a publication that then failed stays
//   applied, and the retry finds it so.
// - The store deleted under a version that binds it: the binding row is
//   what deletion checks (`data.store_bound`, data-stores.ts).

/** A workflow store, as the version that declares it binds it. */
export interface WorkflowStoreBinding {
  /** The store's name in the definition. */
  readonly name: string;
  readonly storeId: StoreId;
  /** The schema the store holds for this version (`schemaHash`). */
  readonly schemaHash: string;
  /** The hash of its operations' fingerprints, by path. */
  readonly operationManifestHash: string;
}

/** The store workflow `workflowId` declared as `name`, if it has one. */
const storeNamed = async (
  env: Env,
  workflowId: string,
  name: string
): Promise<StoreId | undefined> => {
  const row = await drizzle(env.DB)
    .select({ storeId: workflowStores.storeId })
    .from(workflowStores)
    .where(
      and(
        eq(workflowStores.workflowId, workflowId),
        eq(workflowStores.name, name)
      )
    )
    .get();
  return row === undefined ? undefined : storeIdSchema.parse(row.storeId);
};

/**
 * The store workflow `workflowId` declares as `name`: the one it made
 * before, or a new one, created in one audited batch with its name and
 * its owner claim. A creation that loses a race to another for the same
 * name answers the winner's.
 */
const storeFor = async (
  env: Env,
  by: Acting,
  workflowId: string,
  name: string
): Promise<StoreId> => {
  const found = await storeNamed(env, workflowId, name);
  if (found !== undefined) {
    return found;
  }
  const id = storeIdSchema.parse(crypto.randomUUID());
  const createdAt = new Date();
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(workflowStores).values({
        workflowId,
        name,
        storeId: id,
        createdAt,
      }),
      db.insert(businessStores).values({
        id,
        ownerId: by.userId,
        physicalNamespaceRole: "data_store",
        createdAt,
      }),
      db
        .insert(sdkStoreOwners)
        .values({ storeId: id, workflowId, claimedAt: createdAt }),
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "store.created",
        target: { type: "store", id },
        detail: { workflow: workflowId, name },
      }),
    ]);
    return id;
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const won = await storeNamed(env, workflowId, name);
    if (won === undefined) {
      throw error;
    }
    return won;
  }
};

/**
 * The stores `stores` declares for version `version` of workflow
 * `workflowId`, each created if the workflow has none of that name yet
 * and handed the version's schema, as `by` publishes it. `by` must build
 * in the organization and not be Grasp staff; none of this is checked or
 * done for a version that declares no store.
 */
export const provideWorkflowStores = async (
  env: Env,
  by: Acting,
  workflowId: string,
  version: number,
  stores: ReadonlyMap<string, SealedStore>
): Promise<WorkflowStoreBinding[]> => {
  if (stores.size === 0) {
    return [];
  }
  requireBuilder(by);
  requireNotStaff(by);
  const bindings: WorkflowStoreBinding[] = [];
  // One store after another: each is its own object, and a refusal stops
  // the publication before the next is touched.
  for (const [name, store] of stores) {
    // oxlint-disable-next-line no-await-in-loop -- see above
    const storeId = await storeFor(env, by, workflowId, name);
    // oxlint-disable-next-line no-await-in-loop -- see above
    const opened = await openStore(env, storeId);
    // oxlint-disable-next-line no-await-in-loop -- see above
    const defined = await defineSchemaOnStore(
      env,
      opened,
      manifestText(store.manifest),
      { resourceId: workflowId, resourceVersion: version }
    );
    if (defined.schemaHash !== store.schemaHash) {
      throw new Error("The store defined another schema than the workflow's");
    }
    bindings.push({
      name,
      storeId,
      schemaHash: store.schemaHash,
      // oxlint-disable-next-line no-await-in-loop -- see above
      operationManifestHash: await sha256Hex(
        canonicalJson({ ...store.fingerprints })
      ),
    });
  }
  return bindings;
};

/**
 * Store `storeId` as a binding of a workflow's version names it: only
 * while workflow `workflowId` owns it and it is live and not being
 * deleted; otherwise NULL, which the column refuses, and the whole
 * publication with it.
 */
const boundStoreSql = (storeId: StoreId, workflowId: string): SQL =>
  sql`(SELECT ${storeId} WHERE EXISTS (SELECT 1 FROM sdk_store_owners
    WHERE store_id = ${storeId} AND workflow_id = ${workflowId})
    AND ${liveStoreSql(sql`${storeId}`, Date.now())})`;

/**
 * The statements that bind `stores` to version `version` of workflow
 * `workflowId`, for the batch that writes the version: each store's
 * definition in core's inventory (numbered as it first appears), and the
 * binding that names it.
 */
export const workflowStoreStatements = (
  db: DrizzleD1Database,
  workflowId: string,
  version: number,
  manifestHash: string,
  stores: readonly WorkflowStoreBinding[]
) =>
  stores.flatMap((store) => [
    db
      .insert(businessStoreVersions)
      .values({
        storeId: store.storeId,
        version: sql`COALESCE((SELECT MAX(version) FROM business_store_versions
          WHERE store_id = ${store.storeId}), 0) + 1`,
        schemaHash: store.schemaHash,
        operationManifestHash: store.operationManifestHash,
        // A workflow's store has no source tree: its definition is the
        // version's, which its manifest hash names.
        sourceTreeHash: manifestHash,
        createdAt: new Date(),
      })
      .onConflictDoNothing({
        target: [
          businessStoreVersions.storeId,
          businessStoreVersions.schemaHash,
          businessStoreVersions.operationManifestHash,
        ],
      }),
    db.insert(sdkResourceBindings).values({
      resourceId: workflowId,
      resourceVersion: version,
      // Apart from the definition's binding aliases, which are identifiers.
      alias: storeAlias(store.name),
      kind: "store" as const,
      targetId: boundStoreSql(store.storeId, workflowId),
      targetVersion: sql`(SELECT version FROM business_store_versions
        WHERE store_id = ${store.storeId} AND schema_hash = ${store.schemaHash}
          AND operation_manifest_hash = ${store.operationManifestHash})`,
      schemaHash: store.schemaHash,
      manifestHash,
    }),
  ]);
