import type { AnyPermission } from "@grasp-os/runtime/app";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { HeldBinding } from "@grasp-os/shared/capability";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { functionErrors } from "@grasp-os/shared/functions";
import type { AppId, ConnectionId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { Provenance } from "@grasp-os/shared/knowledge";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import type { BindingTarget } from "@grasp-os/shared/resource-bindings";

import type { ResourceContext } from "./function-host.ts";

// How a resource binding reaches its provider (resource-bindings.ts): one
// adapter per kind of target a permission binds to. An adapter runs in
// core, never in App code, and reaches its provider only through the
// platform's own way out: the model gateway, connect, the Brain's delegate
// reads, the platform's own reads. Whatever it answers is checked again
// by the function host against the declaration's contract before App
// code sees it.

/**
 * Where what an invocation read through its resources comes from: the
 * Knowledge collections and their classification, and each connection it
 * read from with the resources (messages, files) that connection's
 * connector named. It goes back to the caller with the answer.
 */
export interface InvocationProvenance extends Provenance {
  readonly connections: readonly {
    readonly connectionId: string;
    readonly resources: readonly string[];
  }[];
  /**
   * Some connection resources read were left out: past
   * `provenanceMaxResources`, only the connection is named.
   */
  readonly truncated: boolean;
}

/** The most connection resources one invocation's provenance names. */
export const provenanceMaxResources = 1000;

/**
 * What an invocation has read so far, from every source it read through
 * its resources. It is the provenance of the invocation's next model
 * request, and goes back to the caller with the
 * answer.
 */
export interface InvocationSources {
  readonly note: (provenance: Provenance) => void;
  readonly snapshot: () => InvocationProvenance;
  /** Notes that data of connection `id`, from `resources`, reached it. */
  readonly noteConnection: (id: string, resources: readonly string[]) => void;
}

/** A new invocation's sources: nothing read yet. */
export const invocationSources = (): InvocationSources => {
  const collectionIds = new Set<Provenance["collectionIds"][number]>();
  const connections = new Map<string, Set<string>>();
  let resourceCount = 0;
  let truncated = false;
  let sensitive = false;
  let restricted = false;
  return {
    note: (provenance) => {
      for (const id of provenance.collectionIds) {
        collectionIds.add(id);
      }
      sensitive ||= provenance.sensitive;
      restricted ||= provenance.restricted;
    },
    snapshot: () => ({
      collectionIds: [...collectionIds].toSorted(),
      sensitive,
      restricted,
      connections: [...connections]
        .toSorted(([one], [other]) => one.localeCompare(other))
        .map(([connectionId, resources]) => ({
          connectionId,
          resources: [...resources].toSorted(),
        })),
      truncated,
    }),
    noteConnection: (id, resources) => {
      const known = connections.get(id) ?? new Set<string>();
      connections.set(id, known);
      // Bounded: the connection is always named, its resources up to a
      // limit across the invocation.
      for (const resource of resources) {
        if (known.has(resource)) {
          continue;
        }
        if (resourceCount < provenanceMaxResources) {
          known.add(resource);
          resourceCount += 1;
        } else {
          truncated = true;
        }
      }
    },
  };
};

/**
 * A target's provider couldn't be reached to say what it serves now (a
 * Composio server that didn't answer): `permission.unavailable` for this
 * request, but nothing is known to have changed, so a held call of the
 * binding keeps waiting instead of being dropped as stale
 * (`isProviderUnreachable`).
 */
export const providerUnreachable = () =>
  functionErrors.create("permission.unavailable", { transient: true });

/** Whether `error` is {@link providerUnreachable}'s. */
export const isProviderUnreachable = (error: unknown): boolean =>
  functionErrors.codeOf(error) === "permission.unavailable" &&
  typeof error === "object" &&
  error !== null &&
  "details" in error &&
  typeof error.details === "object" &&
  error.details !== null &&
  "transient" in error.details &&
  error.details.transient === true;

/** Who an invocation acts for, as core resolved it, and where it works. */
export interface BindingCaller {
  readonly app: AppId;
  readonly authority: Authority;
  readonly context: WorkContext;
  readonly sources: InvocationSources;
  /**
   * Who the audit log names as making each request, and whose spend a
   * model request counts in besides the binding's own: the App, for a
   * page's or an agent's call (`delegateActorOf`).
   */
  readonly actor: AuditActor;
  /**
   * For a workflow run's call: hears that connect held the side effect of
   * the request keyed `key` for the person the run acts for
   * (`connect.held`), so the run's step waits for their decision whatever
   * App code does with the refusal (workflows/host.ts). A person who is
   * there gets the held action back instead, so none is needed.
   */
  readonly held?: (key: string) => void;
  /**
   * For a workflow run's call: throws, synchronously, once the run's
   * step attempt no longer holds its lease. An adapter runs it last
   * before its side effect leaves core (connect's call, the provider
   * request), with nothing awaited in between, so a cancel landing while
   * it prepared the request stops it. A page's or agent's call has its
   * gate (`authorize`) only.
   */
  readonly requireHolds?: () => void;
  /**
   * The invocation's own gate (`Invocation.authorize`): throws once the
   * caller may no longer act (the release revoked, a role lost, an
   * agent's permission or a step's lease gone). The function host runs
   * it before each request; an adapter whose request commits later, a
   * shared store's mutation (resource-store.ts), runs it again just
   * before that commit.
   */
  readonly admit?: () => Promise<unknown>;
  /**
   * What the invocation has used of the bounds an adapter holds it to per
   * invocation, by the adapter's own names (resource-grasp.ts): one
   * map for the whole invocation, whichever of its requests resolved its
   * binding (`resourceBindingsFor` makes it).
   */
  readonly counts?: Map<string, number>;
}

/** The permission each kind of binding target serves. */
interface PermissionOfTarget {
  readonly model: "ai";
  readonly connector: "connections";
  readonly knowledge: "brain";
  readonly grasp: "grasp";
  readonly guests: "guests";
}

/** The declaration a target of `Kind` serves, as its adapter is given it. */
export type DeclarationOf<Kind extends BindingTarget["kind"]> = Extract<
  AnyPermission,
  { "~permission": PermissionOfTarget[Kind] }
>;

/**
 * The kind of target `declaration` binds to: AI to a model, a connection
 * to a connection permission, the Brain to collection permissions, guests
 * to the platform's guests permission, and the platform's own functions
 * (`grasp`) to its statistics permission.
 */
export const targetKindOf = (
  declaration: AnyPermission
): BindingTarget["kind"] => {
  const kind = declaration["~permission"];
  if (kind === "ai") {
    return "model";
  }
  if (kind === "connections") {
    return "connector";
  }
  if (kind === "brain") {
    return "knowledge";
  }
  if (kind === "guests") {
    return "guests";
  }
  return "grasp";
};

/** A binding target of one kind. */
export type TargetOf<Kind extends BindingTarget["kind"]> = Extract<
  BindingTarget,
  { kind: Kind }
>;

/** The contract a binding serves, as its provider describes it now. */
export interface ServedContract {
  readonly contractId: string;
  /** The SHA-256 of the contract's canonical description. */
  readonly fingerprint: string;
}

/**
 * What the binding's row says beyond its pin, as read for this request:
 * the alias it binds.
 */
export interface BindingRecord {
  readonly alias: string;
}

/** A target bound for a request: what it serves now, and how to call it. */
export interface ServedBinding extends ServedContract {
  /**
   * One request through the target, for `caller`. The function host
   * checked the method and arguments against the declaration already
   * (`allowedRequest`), and checks the answer after.
   */
  readonly call: (
    caller: BindingCaller,
    request: { method: string; args: readonly Json[] },
    context: ResourceContext,
    pin: HeldBinding,
    record: BindingRecord
  ) => Promise<unknown>;
  /**
   * For a connector: the connector tools the bound actions name, the only
   * ones a held call of the binding may be confirmed for.
   */
  readonly tools?: readonly string[];
}

/**
 * How one review of an App's resources asks connect what connections
 * serve: each (connection, contract) once, across every binding and
 * choice it checks, and no more than its limit. A request never uses it:
 * it asks connect live, every time.
 */
export interface ContractAsks {
  /**
   * What connection `connectionId` serves of `contract` (undefined when it
   * serves none), or `unchecked` once the review's limit is spent.
   */
  readonly contractOf: (
    connectionId: ConnectionId,
    contract: string
  ) => Promise<ConnectorContract | undefined | typeof unchecked>;
}

/**
 * What a review's bind answers for a target it couldn't check within its
 * limit: never served, and said to be unchecked.
 */
export const unchecked = "unchecked";

/** One kind's adapter. */
export interface ResourceAdapter<Kind extends BindingTarget["kind"]> {
  /**
   * `target` for `declaration`, if `app` may bind it now: the App's own
   * active grant, a model the deployment allows, another App that serves
   * what it declares; with the contract it serves now.
   * Undefined otherwise. Asked as an admin approves the binding, and
   * again for every request, so a drifted contract or a lost grant stops
   * it. A review passes its `asks`, so what it asks connect is shared and
   * bounded; then a target it couldn't check is `unchecked`.
   */
  readonly bind: (
    env: Env,
    app: AppId,
    declaration: DeclarationOf<Kind>,
    target: TargetOf<Kind>,
    asks?: ContractAsks
  ) => Promise<ServedBinding | undefined | typeof unchecked>;
}
