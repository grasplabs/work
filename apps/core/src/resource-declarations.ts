import type { AnyResource } from "@grasp-os/sdk";
import type { AppManifest } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { jsonOf } from "@grasp-os/shared/operations";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { sdkResourceBindings } from "./db/core/schema.ts";

/**
 * A resource declaration's SHA-256, as a release seals it: what an
 * approved binding pins (resource-bindings.ts), and what a release's
 * inventory row of a declared store resource names until an approval
 * resolves it (app-releases.ts).
 */
export const declarationHash = async (
  declaration: AnyResource
): Promise<string> => {
  const json = jsonOf(declaration);
  if (json === undefined) {
    throw new Error("A resource declaration is JSON");
  }
  return await sha256Hex(canonicalJson(json));
};

/**
 * The inventory alias (`sdk_resource_bindings.alias`) of an App's declared
 * store resource `alias`: apart from its own store's (`default`), which a
 * resource may be called too, since a resource alias never holds a dot.
 */
export const storeResourceAlias = (alias: string): string =>
  `resources.${alias}`;

/** The store resources `manifest` declares, each with its declaration's hash. */
export const declaredStoreResources = async (
  manifest: Pick<AppManifest, "resources">
): Promise<{ alias: string; hash: string }[]> =>
  await Promise.all(
    Object.entries(manifest.resources)
      .filter(([, declaration]) => declaration["~resource"] === "store")
      .map(async ([alias, declaration]) => ({
        alias,
        hash: await declarationHash(declaration),
      }))
  );

type Db = ReturnType<typeof drizzle>;

/**
 * The store an App's store-resource approval resolves (the store its
 * permission names) and the definition the store's owning App serves
 * now: what the inventory row of that resource names while the approval
 * does.
 */
const storeOfApproval = (approval: SQL): SQL =>
  sql`(SELECT permission.object_id FROM app_resource_bindings AS approval
    JOIN permissions AS permission
      ON permission.id = json_extract(approval.target, '$.permissionId')
      AND permission.object_type = 'store'
    WHERE approval.id = ${approval})`;

const definitionOf = (store: SQL): SQL =>
  sql`(SELECT own.target_version FROM sdk_resource_bindings AS own
    JOIN sdk_store_owners AS owner ON owner.app_id = own.resource_id
    JOIN apps ON apps.id = owner.app_id
      AND apps.current_version = own.resource_version
    WHERE owner.store_id = ${store} AND own.kind = 'store'
      AND own.target_id = owner.store_id
      AND own.alias = 'default')`;

/**
 * Writes onto the inventory row of store resource `alias` of App `app`'s
 * releases (only `version`'s, if given) whose declaration hashes
 * `declared` the store approval `approval` resolves, its definition and
 * the approval, when that approval is there: so the row names what serves
 * the resource exactly while an approval does (spec 24).
 */
export const projectStoreResource = (
  db: Db,
  {
    app,
    version,
    alias,
    declared,
    approval,
  }: {
    app: string;
    version?: number;
    alias: string;
    declared: string;
    approval: SQL;
  }
) => {
  const store = storeOfApproval(approval);
  return db
    .update(sdkResourceBindings)
    .set({
      targetId: sql`${store}`,
      targetVersion: sql`${definitionOf(store)}`,
      approvalId: sql`${approval}`,
    })
    .where(
      and(
        eq(sdkResourceBindings.resourceId, app),
        version === undefined
          ? undefined
          : eq(sdkResourceBindings.resourceVersion, version),
        eq(sdkResourceBindings.alias, storeResourceAlias(alias)),
        eq(sdkResourceBindings.kind, "storeResource"),
        eq(sdkResourceBindings.schemaHash, declared),
        sql`${store} IS NOT NULL`
      )
    );
};

/**
 * Resets the inventory rows store-resource approval `approval` resolved,
 * when `when` holds: each names its declaration's hash alone again.
 */
export const unprojectStoreResource = (db: Db, approval: string, when: SQL) =>
  db
    .update(sdkResourceBindings)
    .set({
      targetId: sql`${sdkResourceBindings.schemaHash}`,
      targetVersion: null,
      approvalId: null,
    })
    .where(
      and(
        eq(sdkResourceBindings.kind, "storeResource"),
        isNotNull(sdkResourceBindings.approvalId),
        eq(sdkResourceBindings.approvalId, approval),
        when
      )
    );
