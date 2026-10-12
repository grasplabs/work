import type { AnyResource } from "@grasp-os/sdk";
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
 * What an invocation has read so far, from every source it read through
 * its resources: Knowledge collections, their classification included. It
 * feeds the model gateway's data rules on the invocation's next model
 * request, and goes back to the caller with the answer.
 */
export interface InvocationSources {
  readonly note: (provenance: Provenance) => void;
  readonly snapshot: () => Provenance;
}

/** A new invocation's sources: nothing read yet. */
export const invocationSources = (): InvocationSources => {
  const collectionIds = new Set<Provenance["collectionIds"][number]>();
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
    }),
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

/** One kind's adapter. */
export interface ResourceAdapter<Kind extends BindingTarget["kind"]> {
  /**
   * What `target` serves for `declaration` now, if `app` may bind it: the
   * App's own active grant, a model the deployment allows, a published
   * template version of the declared contract. Undefined otherwise. Asked
   * as an admin approves the binding, and again on every request, so a
   * drifted contract or a lost grant stops it.
   */
  readonly served: (
    env: Env,
    app: AppId,
    declaration: DeclarationOf<Kind>,
    target: TargetOf<Kind>
  ) => Promise<ServedContract | undefined>;
  /**
   * One request of `declaration` through `target`, for `caller`. The
   * operation host checked the method and arguments against the
   * declaration already (`allowedRequest`), and checks the answer after.
   */
  readonly call: (
    env: Env,
    caller: BindingCaller,
    declaration: DeclarationOf<Kind>,
    target: TargetOf<Kind>,
    request: { method: string; args: readonly Json[] },
    context: ResourceContext
  ) => Promise<unknown>;
}
