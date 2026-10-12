import type { AnyResource } from "@grasp-os/sdk";
import type { HeldBinding } from "@grasp-os/shared/capability";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { Provenance } from "@grasp-os/shared/knowledge";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import type { BindingTarget } from "@grasp-os/shared/resource-bindings";

import type { ResourceContext } from "./operations.ts";

// How a resource binding reaches its provider (resource-bindings.ts): one
// adapter per kind of declaration. An adapter runs in core, never in App
// code, and reaches its provider only through the platform's own way out:
// the model gateway, connect, Knowledge's delegate reads, the template
// records. Whatever it answers is checked again by the operation host
// against the declaration's contract before App code sees it.

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
 * its resources. It feeds the model gateway's data rules on the
 * invocation's next model request, and goes back to the caller with the
 * answer.
 */
export interface InvocationSources {
  readonly note: (provenance: Provenance) => void;
  readonly snapshot: () => InvocationProvenance;
  /** Notes that data of connection `id`, from `resources`, reached it. */
  readonly noteConnection: (id: string, resources: readonly string[]) => void;
  /** The connections whose data reached it, for the model gateway's rules. */
  readonly connections: () => readonly string[];
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
    connections: () => [...connections.keys()].toSorted(),
  };
};

/** Who an invocation acts for, as core resolved it, and where it works. */
export interface BindingCaller {
  readonly app: AppId;
  readonly authority: Authority;
  readonly context: WorkContext;
  readonly sources: InvocationSources;
}

/** A declaration of one kind, as an adapter is given it. */
export type DeclarationOf<Kind extends AnyResource["~resource"]> = Extract<
  AnyResource,
  { "~resource": Kind }
>;

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

/** A target bound for a request: what it serves now, and how to call it. */
export interface ServedBinding extends ServedContract {
  /**
   * One request through the target, for `caller`. The operation host
   * checked the method and arguments against the declaration already
   * (`allowedRequest`), and checks the answer after.
   */
  readonly call: (
    caller: BindingCaller,
    request: { method: string; args: readonly Json[] },
    context: ResourceContext,
    pin: HeldBinding
  ) => Promise<unknown>;
  /**
   * For a connector: the connector tools the bound actions name, the only
   * ones a held call of the binding may be confirmed for.
   */
  readonly tools?: readonly string[];
}

/** One kind's adapter. */
export interface ResourceAdapter<Kind extends BindingTarget["kind"]> {
  /**
   * `target` for `declaration`, if `app` may bind it now: the App's own
   * active grant, a model the deployment allows, a published template
   * version of the declared contract; with the contract it serves now.
   * Undefined otherwise. Asked as an admin approves the binding, and
   * again for every request, so a drifted contract or a lost grant stops
   * it.
   */
  readonly bind: (
    env: Env,
    app: AppId,
    declaration: DeclarationOf<Kind>,
    target: TargetOf<Kind>
  ) => Promise<ServedBinding | undefined>;
}
