import type { AppId, StoreId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import type { Authority } from "@grasp-os/shared/permissions";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appResourceBindings } from "./db/core/schema.ts";
import type { DeclarationOf, ResourceAdapter } from "./resource-adapter.ts";
import { isRestricted, restrict } from "./restricted.ts";
import {
  callStoreOperation,
  declaredFingerprint,
  operationsIn,
  servedFingerprint,
  storeGrantFor,
} from "./store-operations.ts";
import type {
  ServedStoreOperation,
  StoreConsumer,
  StoreGrant,
} from "./store-operations.ts";

// A store resource (resource-bindings.ts): an App's binding of another
// business store's public operations to one of its store permissions. The
// store's operations run as store-operations.ts runs them, for the App as
// the consumer; this adapter only matches the App's declaration with what
// the store serves. Each declared operation must be served exactly as the
// App declares it: the same kind, arguments and return, by the contract
// fingerprint the store's App's release gives it. The binding's contract
// is the store, and its fingerprint covers every declared operation's. A
// store that no longer serves one of them exactly as declared can't be
// bound at all (`grant_lost`): nothing it serves is ever matched against
// a declaration it differs from, and an admin can't approve it either.

/** A store binding's contract: the store it binds, by its ID. */
const contractOf = (storeId: string): string => `store:${storeId}`;

/** Every operation a store declaration lists, as one store serves it now. */
interface ServedDeclaration {
  readonly storeId: StoreId;
  readonly served: ReadonlyMap<string, ServedStoreOperation>;
  readonly fingerprints: Readonly<Record<string, string>>;
}

/**
 * Each operation `declaration` lists, served exactly as declared by
 * `grant`, the store permission as it stands now; undefined when any isn't.
 */
const servedBy = async (
  grant: StoreGrant,
  declaration: DeclarationOf<"store">
): Promise<ServedDeclaration | undefined> => {
  const entries = Object.entries(declaration.operations);
  const served = operationsIn(
    grant,
    entries.map(([path]) => path)
  );
  const fingerprints: Record<string, string> = {};
  let storeId: StoreId | undefined;
  for (const [path, shape] of entries) {
    const operation = served?.get(path);
    // One after the other: a digest is quick, and the first that isn't
    // served as declared settles it.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const declared = await declaredFingerprint(shape);
    if (operation === undefined || operation.fingerprint !== declared) {
      return undefined;
    }
    ({ storeId } = operation);
    fingerprints[path] = operation.fingerprint;
  }
  return storeId === undefined || served === undefined
    ? undefined
    : { storeId, served, fingerprints };
};

/** The store permission `permissionId` of App `app`, as it stands now. */
export const appStoreGrant = async (
  env: Env,
  app: AppId,
  permissionId: string
): Promise<StoreGrant | undefined> => {
  // Only the permission matters to resolve it; a call names the rest.
  const consumer: StoreConsumer = {
    subject: { type: "app", id: app },
    version: 1,
    permissionId,
  };
  return await storeGrantFor(env, consumer);
};

/**
 * Whether `grant` serves every operation `declaration` lists, exactly as
 * declared: what an admin's choices offer, read from a grant a review
 * resolved once for all its resources.
 */
export const grantServes = async (
  grant: StoreGrant,
  declaration: DeclarationOf<"store">
): Promise<boolean> => (await servedBy(grant, declaration)) !== undefined;

export const storeAdapter: ResourceAdapter<"store"> = {
  bind: async (env, app, declaration, target) => {
    const grant = await appStoreGrant(env, app, target.permissionId);
    const all =
      grant === undefined ? undefined : await servedBy(grant, declaration);
    // Not served: what was resolved, nothing.
    if (all === undefined) {
      return all;
    }
    const { served, storeId, fingerprints } = all;
    return {
      contractId: contractOf(storeId),
      fingerprint: await servedFingerprint(storeId, fingerprints),
      call: async (caller, request, context, pin) => {
        const [path, args] = request.args;
        const operation =
          typeof path === "string" ? served.get(path) : undefined;
        if (operation === undefined || args === undefined) {
          throw operationErrors.create("resource.not_allowed");
        }
        // The App version whose code calls: approved, or nothing commits
        // (store-operations.ts). The host always sets it for an App; without
        // it, nothing runs.
        const { appVersion } = caller.authority;
        if (appVersion === undefined) {
          throw operationErrors.create("resource.unavailable");
        }
        const consumer: StoreConsumer = {
          subject: { type: "app", id: app },
          version: appVersion,
          permissionId: target.permissionId,
        };
        const runId =
          caller.context.type === "run" ? caller.context.runId : null;
        // Restricted mode follows the data both ways (restricted.ts), each
        // flag set before the data moves: a restricted caller restricts the
        // store's App before its arguments reach it, and a restricted store
        // App restricts the caller before its answer, or its refusal,
        // reaches it. Should that fail, so does the call: failing closed.
        const owner: Authority = {
          subject: { type: "app", appId: operation.owner },
          onBehalfOf: caller.authority.onBehalfOf,
          mode: caller.authority.mode,
          appVersion: operation.release.manifest.resourceVersion,
        };
        const ownerContext = { type: "app", appId: operation.owner } as const;
        if (await isRestricted(env, caller.authority, caller.context)) {
          await restrict(env, owner, ownerContext, [`app:${app}`]);
        }
        const carryRestricted = async (): Promise<void> => {
          if (await isRestricted(env, owner, ownerContext)) {
            await restrict(env, caller.authority, caller.context, [
              `app:${operation.owner}`,
            ]);
          }
        };
        const called = callStoreOperation(env, consumer, operation, args, {
          actor: caller.actor,
          principal: caller.authority.onBehalfOf,
          requestId: context.requestId,
          deadline: context.deadline,
          idempotencyKey: context.idempotencyKey,
          runId,
          // On-prem, a child of the calling action's sandbox session: it
          // never waits for a process the action holds while it waits.
          ...(context.session === undefined
            ? {}
            : { parentSession: context.session }),
          // Before each protected step of the store's operation: the App's
          // own gate (its release, the person's role, an agent's
          // permission, a run's lease), then the binding as it resolved
          // for this request, still active. Either withdrawn meanwhile
          // stops the commit.
          stillAllowed: async () => {
            await caller.admit?.();
            const row = await drizzle(env.DB)
              .select({ id: appResourceBindings.id })
              .from(appResourceBindings)
              .where(
                and(
                  eq(appResourceBindings.id, pin.id),
                  eq(appResourceBindings.appId, app),
                  eq(appResourceBindings.status, "active")
                )
              )
              .get();
            if (row === undefined) {
              throw operationErrors.create("resource.unavailable");
            }
          },
          ...(caller.requireHolds === undefined
            ? {}
            : { requireHolds: caller.requireHolds }),
        });
        let answer: Json;
        try {
          answer = await called;
        } catch (error) {
          await carryRestricted();
          throw error;
        }
        await carryRestricted();
        return answer;
      },
    };
  },
};
