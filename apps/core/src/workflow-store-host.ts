import { declaredStoresOf } from "@grasp-os/open-workflow/stores";
import type {
  DeclaredStoreOperation,
  SealedStore,
} from "@grasp-os/open-workflow/stores";
import { AppError } from "@grasp-os/sdk";
import type { AppManifest } from "@grasp-os/sdk/host";
import type { OperationChannel } from "@grasp-os/sdk/runner";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { StoreReach } from "@grasp-os/shared/permissions";
import { readDescriptorVersion } from "@grasp-os/shared/store-reads";
import { migrationErrors } from "@grasp-os/shared/stores";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  businessStores,
  businessStoreVersions,
  sdkResourceBindings,
  sdkStoreOwners,
  workflowResources,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import type { HostedApp, Runner } from "./operations.ts";
import { schemaStatus } from "./store-backfill.ts";

// A workflow store's generated operations (GRA-682 slice 4), as core's
// operation host runs them (operations.ts, `callOperation`): no App code
// and no sandbox, an in-core runner of the four kinds a workflow declares
// (`get`, `list`, `insert`, `patch`) over the store's one channel, so
// every check the host makes of an App's functions holds for them too:
// arguments validated by the generated descriptor, each read and staged
// write held to the operation's table verbs and the pinned schema, the
// gate run again before the commit, receipts scoped to the consumer.
//
// What serves a store is read again for every call: its owner workflow's
// current version, that version's binding to exactly this store, and the
// store declaration its sealed definition holds, read by the profile's
// own checks (`declaredStoresOf`) and required to be exactly the one the
// version bound (its schema hash and its operations' fingerprints). And
// it serves only while the store holds that schema in force
// (`requireSchemaInForce`): not while a backfill fills in a field the
// version added, nor after a racing publication left the store on
// another schema.

/** A workflow store as its owner's current version serves it now. */
export interface WorkflowStoreServer {
  readonly workflowId: string;
  /** The owner workflow's current version, which binds the store. */
  readonly version: number;
  /** The store's name in that version's definition. */
  readonly name: string;
  readonly store: SealedStore;
}

/** A store's alias among its workflow version's bindings. */
export const storeAlias = (name: string): string => `store:${name}`;

const nameOfAlias = (alias: string): string | undefined =>
  alias.startsWith("store:") ? alias.slice("store:".length) : undefined;

/**
 * The workflow version that serves store `storeId` now: its owner
 * workflow, live, at its current version, which binds exactly this store;
 * that version's declaration of it, read again from its sealed definition
 * and the same as the binding's (schema, and operations by their
 * fingerprints). Undefined for a store no workflow owns, one deleted, or
 * an owner deleted or at a version that doesn't bind it; a declaration
 * that differs from its binding throws (a sealed version changed).
 */
export const workflowStoreServer = async (
  env: Env,
  storeId: StoreId
): Promise<WorkflowStoreServer | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      workflowId: workflowResources.id,
      version: workflowResources.currentVersion,
      alias: sdkResourceBindings.alias,
      schemaHash: sdkResourceBindings.schemaHash,
      operationManifestHash: businessStoreVersions.operationManifestHash,
      definition: workflowResourceVersions.definition,
    })
    .from(sdkStoreOwners)
    .innerJoin(businessStores, eq(businessStores.id, sdkStoreOwners.storeId))
    .innerJoin(
      workflowResources,
      eq(workflowResources.id, sdkStoreOwners.workflowId)
    )
    .innerJoin(
      sdkResourceBindings,
      and(
        eq(sdkResourceBindings.resourceId, workflowResources.id),
        eq(
          sdkResourceBindings.resourceVersion,
          workflowResources.currentVersion
        ),
        eq(sdkResourceBindings.kind, "store"),
        eq(sdkResourceBindings.targetId, sdkStoreOwners.storeId)
      )
    )
    .innerJoin(
      businessStoreVersions,
      and(
        eq(businessStoreVersions.storeId, sdkStoreOwners.storeId),
        eq(businessStoreVersions.version, sdkResourceBindings.targetVersion)
      )
    )
    .innerJoin(
      workflowResourceVersions,
      and(
        eq(workflowResourceVersions.workflowResourceId, workflowResources.id),
        eq(workflowResourceVersions.version, workflowResources.currentVersion)
      )
    )
    .where(
      and(
        eq(sdkStoreOwners.storeId, storeId),
        isNull(businessStores.deletedAt),
        isNull(workflowResources.deletedAt)
      )
    )
    .get();
  const name = row === undefined ? undefined : nameOfAlias(row.alias);
  if (row === undefined || row.version === null || name === undefined) {
    return undefined;
  }
  const declared = await declaredStoresOf(row.definition);
  const store = declared.get(name);
  const operations =
    store === undefined
      ? undefined
      : await sha256Hex(canonicalJson({ ...store.fingerprints }));
  if (
    store === undefined ||
    store.schemaHash !== row.schemaHash ||
    operations !== row.operationManifestHash
  ) {
    throw new Error("A workflow version's store isn't the one it bound");
  }
  return { workflowId: row.workflowId, version: row.version, name, store };
};

/**
 * Refuses (`migration.pending`, retryable) while store `storeId` doesn't
 * hold `server`'s schema in force for its version: a backfill filling in
 * a field the version added, or another schema left by a publication
 * that raced it. Nothing is served then, so nothing reads or writes
 * records the schema doesn't describe.
 */
export const requireSchemaInForce = async (
  env: Env,
  storeId: StoreId,
  server: WorkflowStoreServer
): Promise<void> => {
  const status = await schemaStatus(env, storeId, server.store.schemaHash, {
    resourceId: server.workflowId,
    resourceVersion: server.version,
  });
  if (status.state !== "active") {
    throw migrationErrors.create("migration.pending", { retryable: true });
  }
};

/**
 * Refuses unless the store's owner workflow is still at `server`'s
 * version and that version still binds store `storeId`: a publication
 * landing mid-call commits nothing under the version it replaced.
 */
export const requireStillServing = async (
  env: Env,
  storeId: StoreId,
  server: WorkflowStoreServer
): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ alias: sdkResourceBindings.alias })
    .from(workflowResources)
    .innerJoin(
      sdkResourceBindings,
      and(
        eq(sdkResourceBindings.resourceId, workflowResources.id),
        eq(
          sdkResourceBindings.resourceVersion,
          workflowResources.currentVersion
        ),
        eq(sdkResourceBindings.kind, "store"),
        eq(sdkResourceBindings.targetId, storeId)
      )
    )
    .where(
      and(
        eq(workflowResources.id, server.workflowId),
        eq(workflowResources.currentVersion, server.version),
        isNull(workflowResources.deletedAt)
      )
    )
    .get();
  return row?.alias === storeAlias(server.name);
};

const idArgsSchema = z.object({ id: z.string() });
const listArgsSchema = z.object({
  pageSize: z.number(),
  cursor: z.string().nullable(),
  where: z.record(z.string(), z.unknown()).optional(),
});
const patchArgsSchema = z.object({
  id: z.string(),
  set: z.record(z.string(), z.unknown()),
});
const recordSchema = z.object({ _rev: z.number() }).nullable();

/** A finite JSON scalar, as an index range compares a field with. */
const scalarOf = (value: unknown): string | number | boolean | null =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  value === null
    ? value
    : null;

/** Runs one generated operation over the store's channel. */
const runOperation = async (
  operation: DeclaredStoreOperation,
  indexFields: readonly string[] | undefined,
  args: unknown,
  channel: OperationChannel
): Promise<unknown> => {
  const { kind, table } = operation;
  if (kind === "get") {
    const { id } = idArgsSchema.parse(args);
    return await channel.read({
      kind: "get",
      table,
      id,
      expectedRevision: null,
    });
  }
  if (kind === "list") {
    const { pageSize, cursor, where } = listArgsSchema.parse(args);
    return await channel.read({
      kind: "query",
      query: {
        descriptorVersion: readDescriptorVersion,
        table,
        index: operation.index,
        range: (indexFields ?? []).map((field) => ({
          field,
          op: "eq" as const,
          value: scalarOf(where?.[field]),
        })),
        filter: null,
        order: "asc",
        terminal: { kind: "paginate", pageSize, cursor },
      },
    });
  }
  if (kind === "insert") {
    return await channel.write({
      kind: "insert",
      table,
      fields: z.record(z.string(), z.unknown()).parse(args),
    });
  }
  const { id, set } = patchArgsSchema.parse(args);
  // Guarded by the revision read: a change landing in between refuses the
  // commit, and the caller's retry patches the record as it is then.
  const current = recordSchema.parse(
    await channel.read({ kind: "get", table, id, expectedRevision: null })
  );
  if (current === null) {
    throw new AppError("record.not_found", "There is no such record.");
  }
  await channel.write({
    kind: "patch",
    table,
    id,
    fields: set,
    unset: [],
    expectedRevision: current._rev,
  });
  return null;
};

/**
 * The store's generated operations as core's operation host runs an App:
 * a manifest of its schema and its operations (public, no resources, no
 * screens), and a runner of the four kinds.
 */
export const hostedWorkflowStore = (server: WorkflowStoreServer): HostedApp => {
  const { store } = server;
  const operations = Object.fromEntries(
    [...store.operations].map(([path, { manifest }]) => [path, manifest])
  );
  const manifest: AppManifest = {
    name: `${server.workflowId}:${server.name}`,
    schema: store.manifest,
    operations,
    resources: {},
    browserResources: {},
    workflows: {},
    screens: {},
    surfaces: {},
    preferences: null,
    migrations: {},
  };
  const run: Runner = async (path, args, channel) => {
    const operation = store.operations.get(path);
    if (operation === undefined) {
      throw Object.assign(new Error("There is no such operation."), {
        code: "operation.not_found",
      });
    }
    const indexFields =
      operation.index === null
        ? undefined
        : store.manifest.tables[operation.table]?.indexes[operation.index]
            ?.fields;
    return await runOperation(operation, indexFields, args, channel);
  };
  return { manifest, run };
};

/**
 * What each of `actions` reaches on store `storeId`, if a workflow owns
 * it and its current version serves it (`StoreReach`): what an admin
 * reviewing a permission on it consents to. Undefined for any other
 * store, or one nothing serves now.
 */
export const storeReachOf = async (
  env: Env,
  storeId: StoreId,
  actions: readonly string[]
): Promise<StoreReach[] | undefined> => {
  const server = await workflowStoreServer(env, storeId);
  if (server === undefined) {
    return undefined;
  }
  return actions.flatMap((path) => {
    const operation = server.store.operations.get(path);
    return operation === undefined
      ? []
      : [
          {
            operation: path,
            table: operation.table,
            changes: operation.kind === "insert" || operation.kind === "patch",
          },
        ];
  });
};
