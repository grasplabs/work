import { contractFingerprint } from "@grasp-os/sdk/host";
import type { OperationManifest } from "@grasp-os/sdk/host";
import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { internalErrors, isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { effectErrors, operationErrors } from "@grasp-os/shared/operations";
import type { AppErrorPayload } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { memberRole } from "./auth/identity.ts";
import { openStore } from "./data-stores.ts";
import type { OpenStore } from "./data-stores.ts";
import {
  apps,
  businessStores,
  permissions,
  sdkStoreOwners,
} from "./db/core/schema.ts";
import { callOperation } from "./operations.ts";
import type { Invocation } from "./operations.ts";
import { isApprovedVersion } from "./permissions.ts";
import { hostedRelease, requireNotRevoked } from "./release-runner.ts";

// A business store's public operations, shared with other consumers (spec
// 24, 40.8): another App, or an independent workflow, calls the public
// queries and mutations of the App that owns a store, which stays the one
// canonical owner of the store's schema and operations. A consumer copies
// no schema and gets no storage authority: it reaches the store only by
// asking that App's release to run one of its public operations, as the
// App's own screens do. Threat model, and how each is closed:
//
// - Calling an operation that isn't public, or one that reaches outside:
//   only a public query or mutation of the owning App's current release
//   is served. An internal function, an action (which would run with the
//   owning App's own resource bindings) or a path the release doesn't
//   have is refused as one that doesn't exist (`resource.unavailable`),
//   whatever the permission lists.
// - Calling without a grant: a call needs the consumer's own active store
//   permission (subject the consumer itself, object the store, listing the
//   operation's path), which only an admin grants. An App's call also
//   needs an admin's approved binding of the declaration to that
//   permission (resource-bindings.ts), a workflow's an approval of its
//   catalog binding (workflow-bindings.ts). A declaration, a permission
//   naming another consumer, or one of the store owner's grants serves
//   nothing.
// - A revoked grant still working: nothing is resolved once. Every call
//   reads the permission, the store, its owner and the owner's current
//   release again, and the operation host's one gate (`authorize`) reads
//   the permission again before each commit, with the release's
//   revocation and the person's membership; the consumer's own binding is
//   checked there too (`stillAllowed`). Revoking the permission, the
//   binding or the release, or deleting the store, stops the next call
//   and any commit not yet made.
// - Contract drift: a consumer pins the exact contract it was approved for
//   (an App's declaration, by each operation's contract fingerprint, which
//   covers its kind; a workflow's catalog contract, by its exact shapes,
//   and the kind its approval names), and each call compares it with what
//   the owning App's current release serves now. Another kind, arguments
//   or return refuses the call before any input is read. A call commits
//   only while the release it resolved is still the App's current one.
// - Code nobody approved using a grant: an App's call needs the version
//   it runs to be one an admin approved, as a connector's write does
//   (`allowingPermissionSql`). A run keeps the version it started on,
//   which a builder may have made current without approval, the grant
//   given again for a later version since; that run's calls are refused.
// - Calls nobody can trace: every refused call, and every mutation a
//   consumer commits, is recorded with the consumer, its version, its
//   permission and the path, never the arguments.
// - Privilege carried from the store's owner to the caller: the call runs
//   as the person the consumer acts for (`principal`), who owns what it
//   inserts, never as the App's owner or the store's creator; with the
//   role flags of a member of the owning App and never a builder's, so a
//   table only the App's builders read or write stays theirs; with no
//   resource bindings at all (queries and mutations reach none), and in
//   no workflow run of the owning App. Nothing of the owning App's own
//   grants or bindings is reachable.
// - Data of one consumer reaching another: a consumer names only its own
//   permission, found by the consumer's own identity; its receipts and
//   cursors are scoped to it (`consumer`), so a key or cursor of one
//   consumer never answers another's call, nor the owning App's own; and
//   the store comes from the permission and the owning App's sealed
//   binding, never from a request. They are scoped to the consumer, not to
//   one of its bindings: two bindings of one consumer reach the same
//   records for the same person, so nothing passes between them that
//   either couldn't read.
// - Another deployment's or a deleted store: a store resolves only through
//   this core's inventory, live, and only while its owning App's current
//   release is bound to exactly that store.

/** Who consumes a store's public operations: an App, or a workflow. */
export interface StoreConsumer {
  readonly subject:
    | { readonly type: "app"; readonly id: AppId }
    | { readonly type: "workflow"; readonly id: string };
  /** The consumer's version the call comes through: its cursors are bound to it. */
  readonly version: number;
  /** The consumer's own store permission that serves the call. */
  readonly permissionId: string;
}

/** A store operation as a consumer may call it now. */
export interface ServedStoreOperation {
  readonly storeId: StoreId;
  /** The App that owns the store, whose current release runs the call. */
  readonly owner: AppId;
  readonly release: Release;
  readonly operation: OperationManifest;
  /** The operation's contract fingerprint, in that release. */
  readonly fingerprint: string;
}

const actionsSchema = z.array(z.string());

/**
 * The store `consumer`'s own active store permission names, and the paths
 * it lists: never a permission of anyone else, nor one revoked or asked
 * for only.
 */
const grantOf = async (
  env: Env,
  consumer: StoreConsumer
): Promise<{ storeId: StoreId; actions: readonly string[] } | undefined> => {
  const row = await drizzle(env.DB)
    .select({ objectId: permissions.objectId, actions: permissions.actions })
    .from(permissions)
    .where(
      and(
        eq(permissions.id, consumer.permissionId),
        eq(permissions.subjectType, consumer.subject.type),
        eq(permissions.subjectId, consumer.subject.id),
        eq(permissions.objectType, "store"),
        eq(permissions.status, "active"),
        isNull(permissions.chatId)
      )
    )
    .get();
  if (row === undefined) {
    return undefined;
  }
  const actions = actionsSchema.safeParse(JSON.parse(row.actions));
  const store = storeIdSchema.safeParse(row.objectId);
  return actions.success && store.success
    ? { storeId: store.data, actions: actions.data }
    : undefined;
};

/** Whether `actions`, a store permission's, list every one of `paths`. */
const listsAll = (
  actions: readonly string[],
  paths: readonly string[]
): boolean => paths.every((path) => actions.includes(path));

/**
 * The store `consumer`'s own permission names, if it lists every one of
 * `paths` (`grantOf`).
 */
const grantedStore = async (
  env: Env,
  consumer: StoreConsumer,
  paths: readonly string[]
): Promise<StoreId | undefined> => {
  const grant = await grantOf(env, consumer);
  return grant !== undefined && listsAll(grant.actions, paths)
    ? grant.storeId
    : undefined;
};

/**
 * The current release of the App that owns store `id`, if the store is
 * live and that release is bound to exactly it: the release that runs the
 * store's operations now. Undefined for anything else.
 */
const ownerRelease = async (
  env: Env,
  id: StoreId
): Promise<{ owner: AppId; release: Release } | undefined> => {
  const row = await drizzle(env.DB)
    .select({ owner: sdkStoreOwners.appId, version: apps.currentVersion })
    .from(businessStores)
    .innerJoin(sdkStoreOwners, eq(sdkStoreOwners.storeId, businessStores.id))
    .innerJoin(apps, eq(apps.id, sdkStoreOwners.appId))
    .where(and(eq(businessStores.id, id), isNull(businessStores.deletedAt)))
    .get();
  const owner = appIdSchema.safeParse(row?.owner);
  if (row?.version === null || row === undefined || !owner.success) {
    return undefined;
  }
  try {
    const release = await loadRelease(env, owner.data, row.version);
    return release.store?.storeId === id
      ? { owner: owner.data, release }
      : undefined;
  } catch (error) {
    // Revoked, not sealed, or no longer what was sealed: it runs nothing.
    if (isExpectedError(error)) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Operation `path` of `release` as a consumer may call it: a public query
 * or mutation, with its contract fingerprint; undefined for anything else.
 */
const servedIn = (
  release: Release,
  path: string
): Pick<ServedStoreOperation, "operation" | "fingerprint"> | undefined => {
  const operation = Object.hasOwn(release.app.operations, path)
    ? release.app.operations[path]
    : undefined;
  const fingerprint = Object.hasOwn(release.fingerprints, path)
    ? release.fingerprints[path]
    : undefined;
  if (
    operation === undefined ||
    fingerprint === undefined ||
    operation.visibility !== "public" ||
    (operation.kind !== "query" && operation.kind !== "mutation")
  ) {
    return undefined;
  }
  return { operation, fingerprint };
};

/**
 * A consumer's store permission as it stands now: the store, the paths it
 * lists, and the owning App's current release, bound to that store.
 */
export interface StoreGrant {
  readonly storeId: StoreId;
  readonly actions: readonly string[];
  readonly owner: AppId;
  readonly release: Release;
}

/**
 * The store permission `consumer` names, as it stands now (see the
 * header): its own, active, on a live store whose owning App's current
 * release is bound to it, and never that App's own store. Undefined
 * otherwise. Read again for every call; a review reads it once per
 * permission for all its resources.
 */
export const storeGrantFor = async (
  env: Env,
  consumer: StoreConsumer
): Promise<StoreGrant | undefined> => {
  const grant = await grantOf(env, consumer);
  const owned =
    grant === undefined ? undefined : await ownerRelease(env, grant.storeId);
  if (grant === undefined || owned === undefined) {
    return undefined;
  }
  // A store's own App calls its functions as itself, never as a consumer.
  if (consumer.subject.type === "app" && consumer.subject.id === owned.owner) {
    return undefined;
  }
  return { ...grant, ...owned };
};

/**
 * Operations `paths` as `grant` serves them, if it serves every one: the
 * permission lists each, and each is a public query or mutation of the
 * owning App's release. Undefined otherwise.
 */
export const operationsIn = (
  grant: StoreGrant,
  paths: readonly string[]
): ReadonlyMap<string, ServedStoreOperation> | undefined => {
  if (!listsAll(grant.actions, paths)) {
    return undefined;
  }
  const { storeId, owner, release } = grant;
  const served = new Map<string, ServedStoreOperation>();
  for (const path of paths) {
    const found = servedIn(release, path);
    if (found === undefined) {
      return undefined;
    }
    served.set(path, { storeId, owner, release, ...found });
  }
  return served;
};

/**
 * Operations `paths` of the store `consumer`'s permission names, each as
 * the owning App's current release serves it now, if `consumer` may call
 * every one (`storeGrantFor`, `operationsIn`). The permission, the store
 * and its release are read once for them all, and again for every call.
 */
export const storeOperationsFor = async (
  env: Env,
  consumer: StoreConsumer,
  paths: readonly string[]
): Promise<ReadonlyMap<string, ServedStoreOperation> | undefined> => {
  const grant = await storeGrantFor(env, consumer);
  return grant === undefined ? undefined : operationsIn(grant, paths);
};

/** Operation `path` as `storeOperationsFor` serves it, alone. */
export const storeOperationFor = async (
  env: Env,
  consumer: StoreConsumer,
  path: string
): Promise<ServedStoreOperation | undefined> => {
  const served = await storeOperationsFor(env, consumer, [path]);
  return served?.get(path);
};

/**
 * The contract fingerprint a public query or mutation declared with
 * exactly `args` and `returns` has: the one a store's App's release gives
 * the operation it declares so (`contractFingerprint`).
 */
export const declaredFingerprint = async (shape: {
  kind: "query" | "mutation";
  args: OperationManifest["args"];
  returns: OperationManifest["returns"];
}): Promise<string> =>
  await contractFingerprint({
    path: "",
    kind: shape.kind,
    visibility: "public",
    args: shape.args,
    returns: shape.returns,
    stream: null,
    uses: [],
    tables: {},
  });

/** The fingerprint of a whole set of served operations, by path, on a store. */
export const servedFingerprint = async (
  storeId: StoreId,
  fingerprints: Readonly<Record<string, string>>
): Promise<string> =>
  await sha256Hex(canonicalJson({ storeId, operations: { ...fingerprints } }));

/** The receipt of a failed call, as the consumer's code may see it. */
const consumerFailure = (error: AppErrorPayload): Error => {
  // Whether it changed anything is unknown: never run again under a new key.
  if (error.category === "uncertain") {
    return effectErrors.create("effect.outcome_unknown");
  }
  if (error.code === "contract.invalid_args") {
    return operationErrors.create("resource.invalid_args");
  }
  // The same key with other arguments: the consumer's misuse, as for any
  // resource's request, never the store's answer.
  if (error.code === "submission.key_conflict") {
    return operationErrors.create("resource.idempotency_conflict");
  }
  // It couldn't run now (the sandbox busy, a concurrent change): worth
  // trying again, as the store's own caller would be told.
  if (error.retryable) {
    return operationErrors.create("resource.busy", { code: error.code });
  }
  // The platform failed, not the store's contract: never passed off as
  // the store's answer.
  if (error.code.startsWith("internal.")) {
    return internalErrors.create("internal.unexpected", {
      requestId: error.requestId,
    });
  }
  // The store's App or its grants refused who calls, or the operation is
  // gone: the binding doesn't serve.
  if (
    error.category === "authorization" ||
    error.code.startsWith("permission.") ||
    error.code === "operation.not_found" ||
    error.code === "operation.kind_mismatch" ||
    error.code.startsWith("version.")
  ) {
    return operationErrors.create("resource.unavailable");
  }
  // Anything else is the store's own answer: its code only, which its
  // contract gives every caller, never its message or details.
  return operationErrors.create("resource.operation_failed", {
    code: error.code,
  });
};

/** What the audit log records of a consumer's call: identifiers only. */
const consumerDetail = (
  consumer: Pick<StoreConsumer, "subject" | "version" | "permissionId">,
  operation: string
): Record<string, string | number> => ({
  consumerType: consumer.subject.type,
  consumer: consumer.subject.id,
  consumerVersion: consumer.version,
  permissionId: consumer.permissionId,
  operation,
});

/**
 * Records that `consumer`'s call of `operation` on store `storeId` (null
 * when no store resolved) was refused, and why: the consumer, its version,
 * its permission and the path, never the call's arguments. Through the
 * outbox, which never fails the call it records.
 */
export const auditStoreRefusal = async (
  env: Env,
  {
    actor,
    consumer,
    operation,
    storeId,
    reason,
    requestId,
  }: {
    actor: AuditActor;
    consumer: Pick<StoreConsumer, "subject" | "version" | "permissionId">;
    /** The path called, or, for a binding no request could use, its alias. */
    operation: string;
    storeId: string | null;
    reason: string;
    requestId?: string;
  }
): Promise<void> => {
  await keepAuditEvent(env, drizzle(env.DB), {
    actor,
    action: "store.operation.refused",
    target:
      storeId === null
        ? { type: "permission", id: consumer.permissionId }
        : { type: "store", id: storeId },
    ...(requestId === undefined ? {} : { requestId }),
    detail: { ...consumerDetail(consumer, operation), reason },
  });
};

/**
 * Refuses `consumer` unless the version it calls from may change things:
 * for an App, one an admin approved (`madeCurrent`), as a connector's
 * write needs (`allowingPermissionSql`). A run keeps the version it
 * started on, which a builder may have made current without approval,
 * its store grant given again for a later version since. A workflow's
 * versions need no such approval: its approvals name the version.
 */
const requireApprovedConsumer = async (
  env: Env,
  consumer: StoreConsumer
): Promise<void> => {
  if (
    consumer.subject.type === "app" &&
    !(await isApprovedVersion(env, consumer.subject.id, consumer.version))
  ) {
    throw permissionErrors.create("permission.denied", { action: "call" });
  }
};

/**
 * Refuses once `version` is no longer App `owner`'s current version: the
 * store's operations are served by its current release alone, so a call
 * resolved just before a version change commits nothing under the one it
 * left.
 */
const requireStillCurrent = async (
  env: Env,
  owner: AppId,
  version: number
): Promise<void> => {
  const row = await drizzle(env.DB)
    .select({ version: apps.currentVersion })
    .from(apps)
    .where(eq(apps.id, owner))
    .get();
  if (row?.version !== version) {
    throw operationErrors.create("resource.unavailable");
  }
};

/** What core resolved of the caller of one shared store operation. */
export interface StoreOperationCaller {
  /** Who the audit log names as making the call. */
  readonly actor: AuditActor;
  /** The person the consumer acts for: never anyone the request names. */
  readonly principal: string;
  readonly requestId: string;
  readonly deadline: number;
  /** The consumer's own key for the call; hashed into the store's. */
  readonly idempotencyKey: string;
  /** The workflow run the call is made in, whose life keeps its receipt. */
  readonly runId: string | null;
  /**
   * What the consumer's side must still hold before each protected step
   * (its binding still active, its step's attempt still current): throws
   * once it doesn't.
   */
  readonly stillAllowed?: () => Promise<void>;
  /** Throws, synchronously, once the call may not commit: the last check. */
  readonly requireHolds?: () => void;
  /**
   * On-prem, the sandbox session (its call ID) of the code that calls:
   * the store's operation runs in a child of it, never waiting for a
   * process the caller holds while it waits.
   */
  readonly parentSession?: string;
}

/** `store`, its commits made only while `requireHolds` passes. */
const fenced = (store: OpenStore, requireHolds?: () => void): OpenStore =>
  requireHolds === undefined
    ? store
    : {
        ...store,
        commit: async (commit) => {
          requireHolds();
          return await store.commit(commit);
        },
      };

/**
 * Runs `served` (`storeOperationFor`, resolved for this call) with `args`
 * for `consumer`, as `caller` (see the header): its answer, or an
 * expected error the consumer's code may see. The owning App's release
 * runs it, on its store, as the person, a member and never a builder,
 * with no resources; every protected step reads `consumer`'s permission
 * again.
 */
export const callStoreOperation = async (
  env: Env,
  consumer: StoreConsumer,
  served: ServedStoreOperation,
  args: Json,
  caller: StoreOperationCaller
): Promise<Json> => {
  const { release, operation, owner, storeId } = served;
  const version = release.manifest.resourceVersion;
  const invocation: Invocation = {
    principal: caller.principal,
    consumer: {
      resourceId: consumer.subject.id,
      resourceVersion: consumer.version,
    },
    // Each commit names the consumer, kept by the store for good.
    writer: {
      resourceId: consumer.subject.id,
      resourceVersion: consumer.version,
    },
    store: fenced(await openStore(env, storeId), caller.requireHolds),
    requestId: caller.requestId,
    deadline: caller.deadline,
    runId: caller.runId,
    // The serialization point: the operation host runs this gate last
    // before each commit (`fenced` checks only the lease after it). A
    // revocation, a release replaced or a grant withdrawn applies to every
    // call admitted after it; one landing between this gate and the commit
    // doesn't stop that commit. It can't be atomic with it: grants and
    // releases live in core's D1 and the write in the store's own Durable
    // Object, with no transaction across the two. The window is bounded to
    // a call an authorized consumer already had admitted (accepted on
    // GRA-506, as for an App's own mutations).
    authorize: async () => {
      await requireNotRevoked(env, owner, version);
      await requireStillCurrent(env, owner, version);
      if ((await grantedStore(env, consumer, [operation.path])) !== storeId) {
        throw operationErrors.create("resource.unavailable");
      }
      await requireApprovedConsumer(env, consumer);
      if ((await memberRole(env.DB, caller.principal)) === undefined) {
        throw permissionErrors.create("permission.person_inactive");
      }
      await caller.stillAllowed?.();
      // A member of the store's App for the operations granted, never a
      // builder: what only its builders may read or write stays theirs.
      return { appMember: true, appBuilder: false };
    },
  };
  const result = await callOperation(
    hostedRelease(env, release),
    invocation,
    { path: operation.path, kind: operation.kind },
    args,
    // The consumer's own key, hashed to the length a submission key has:
    // the same call made again sends the same key.
    {
      idempotencyKey: await sha256Hex(caller.idempotencyKey),
      ...(caller.parentSession === undefined
        ? {}
        : { parentSession: caller.parentSession }),
    }
  );
  if (!result.ok) {
    const failure = consumerFailure(result.error);
    // Refused by the gate or the store's App: recorded, as a binding a
    // request finds not served is. The store's own answers aren't.
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
  // Every mutation another consumer calls names that consumer. The store
  // keeps who wrote atomically with the write: the commit's receipt is
  // scoped to the consumer (`consumer` above). This event, recorded once
  // the call answered, logs the call: a retry under the same key that its
  // receipt answers is logged as a call too, and one whose answer never
  // reached core still has its receipt naming the consumer.
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
