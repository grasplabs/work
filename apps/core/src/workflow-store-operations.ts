import type { OperationManifest } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { StoreId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { drizzle } from "drizzle-orm/d1";

import { keepAuditEvent } from "./audit-outbox.ts";
import { memberRole } from "./auth/identity.ts";
import { openStore } from "./data-stores.ts";
import { callOperation } from "./operations.ts";
import type { HostedApp, Invocation } from "./operations.ts";
import {
  auditStoreRefusal,
  consumerDetail,
  consumerFailure,
  fenced,
  grantedStore,
} from "./store-operations.ts";
import type {
  StoreConsumer,
  StoreOperationCaller,
} from "./store-operations.ts";
import {
  hostedWorkflowStore,
  requireSchemaInForce,
  requireStillServing,
  workflowStoreServer,
} from "./workflow-store-host.ts";
import type { WorkflowStoreServer } from "./workflow-store-host.ts";

// A workflow store's public operations, as its consumers call them
// (GRA-682 slice 4): the counterpart of store-operations.ts for a store
// a standalone workflow owns, whose operations are the platform's
// generated ones (workflow-store-host.ts) rather than an App's code. A
// consumer reaches them exactly as it reaches an App-owned store's: its
// own active store permission lists the path, and for a workflow an
// approval of its catalog binding (workflow-bindings.ts). Threat model,
// beyond store-operations.ts's, which holds here as there:
//
// - Serving under a schema the store doesn't hold in force: every call
//   requires the store to hold its owner's current version's schema in
//   force, before anything runs and again in the gate before each commit
//   (`migration.pending`, retryable, otherwise).
// - A version replaced mid-call: the gate requires the owner still at the
//   version that resolved and that version still binding the store.
// - The owner workflow calling its own store as a consumer: refused as an
//   operation that isn't served; a workflow's store is its consumers'.
// - An App opening a workflow's store: never. The store's tables admit
//   members (`appMembers`), and this gate is the only path that counts a
//   caller as one for a workflow-owned store: an App's release can't
//   claim or bind it (`version.store_bound_elsewhere`, app-releases.ts),
//   store-operations.ts serves App-owned stores only, an App's permission
//   on it is refused at request (permissions.ts), and it is never shared.
//   Pinned by app-releases.test.ts and store-operations.test.ts ("a store
//   a workflow owns") and by this module's tests.
// - Who the store's records reach: every generated operation reaches
//   every record of its table, whoever owns it; the call runs as the
//   consumer's principal, counted a member (the only members a workflow's
//   store has) and never a builder, with no resources, and the owner
//   workflow runs nothing.

/** A workflow store's operation as a consumer may call it now. */
export interface ServedWorkflowStoreOperation {
  readonly storeId: StoreId;
  readonly server: WorkflowStoreServer;
  readonly hosted: HostedApp;
  readonly operation: OperationManifest;
  /** Its contract fingerprint, in the owner's current version. */
  readonly fingerprint: string;
}

/**
 * Operation `path` of the workflow store `consumer`'s own permission
 * names, as its owner's current version serves it now, if the permission
 * lists it; undefined for a store no workflow serves, an operation it
 * doesn't have, or the owner workflow itself asking.
 */
export const workflowStoreOperationFor = async (
  env: Env,
  consumer: StoreConsumer,
  path: string
): Promise<ServedWorkflowStoreOperation | undefined> => {
  const storeId = await grantedStore(env, consumer, [path]);
  const server =
    storeId === undefined ? undefined : await workflowStoreServer(env, storeId);
  if (storeId === undefined || server === undefined) {
    return undefined;
  }
  if (
    consumer.subject.type === "workflow" &&
    consumer.subject.id === server.workflowId
  ) {
    return undefined;
  }
  const operation = server.store.operations.get(path);
  const fingerprint = server.store.fingerprints[path];
  if (operation === undefined || fingerprint === undefined) {
    return undefined;
  }
  return {
    storeId,
    server,
    hosted: hostedWorkflowStore(server),
    operation: operation.manifest,
    fingerprint,
  };
};

/**
 * Runs `served` with `args` for `consumer`, as `caller`, as
 * store-operations.ts's `callStoreOperation` runs an App-owned store's:
 * through core's operation host, as the person, a member and never a
 * builder, with no resources; every protected step reads the permission,
 * the owner's version and the store's schema again.
 */
export const callWorkflowStoreOperation = async (
  env: Env,
  consumer: StoreConsumer,
  served: ServedWorkflowStoreOperation,
  args: Json,
  caller: StoreOperationCaller
): Promise<Json> => {
  const { storeId, server, hosted, operation } = served;
  // Before anything runs: nothing reads records the schema in force
  // doesn't describe.
  await requireSchemaInForce(env, storeId, server);
  const invocation: Invocation = {
    principal: caller.principal,
    consumer: {
      resourceId: consumer.subject.id,
      resourceVersion: consumer.version,
    },
    writer: {
      resourceId: consumer.subject.id,
      resourceVersion: consumer.version,
    },
    store: fenced(await openStore(env, storeId), caller.requireHolds),
    requestId: caller.requestId,
    deadline: caller.deadline,
    runId: caller.runId,
    // The gate the host runs last before each commit, as for an App-owned
    // store (store-operations.ts): the window between it and the commit is
    // the same one, accepted on GRA-506.
    authorize: async () => {
      if (!(await requireStillServing(env, storeId, server))) {
        throw operationErrors.create("resource.unavailable");
      }
      await requireSchemaInForce(env, storeId, server);
      if ((await grantedStore(env, consumer, [operation.path])) !== storeId) {
        throw operationErrors.create("resource.unavailable");
      }
      if ((await memberRole(env.DB, caller.principal)) === undefined) {
        throw permissionErrors.create("permission.person_inactive");
      }
      await caller.stillAllowed?.();
      // The store's only members are the consumers its operations serve.
      return { appMember: true, appBuilder: false };
    },
  };
  const result = await callOperation(
    hosted,
    invocation,
    { path: operation.path, kind: operation.kind },
    args,
    {
      idempotencyKey: await sha256Hex(caller.idempotencyKey),
      ...(caller.parentSession === undefined
        ? {}
        : { parentSession: caller.parentSession }),
    }
  );
  if (!result.ok) {
    const failure = consumerFailure(result.error);
    if (operationErrors.codeOf(failure) === "resource.unavailable") {
      await auditStoreRefusal(env, {
        actor: caller.actor,
        consumer,
        operation: operation.path,
        storeId,
        reason: result.error.code,
        requestId: caller.requestId,
      });
    }
    throw failure;
  }
  if (operation.kind === "mutation") {
    await keepAuditEvent(env, drizzle(env.DB), {
      actor: caller.actor,
      action: "store.operation.called",
      target: { type: "store", id: storeId },
      requestId: caller.requestId,
      detail: consumerDetail(consumer, operation.path),
    });
  }
  return result.value;
};
