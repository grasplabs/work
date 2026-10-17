import type { AnyResource } from "@grasp-os/sdk";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { HeldBinding } from "@grasp-os/shared/capability";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import type { AppId, ConnectionId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { Provenance } from "@grasp-os/shared/knowledge";
import type { OperationResult } from "@grasp-os/shared/operations";
import { operationErrors } from "@grasp-os/shared/operations";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import type {
  BindingTarget,
  ModelBindingBudget,
} from "@grasp-os/shared/resource-bindings";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import type { ResourceContext } from "./operations.ts";
import type { CallingAgent } from "./workflow-start-intents.ts";

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

/**
 * A target's provider couldn't be reached to say what it serves now (a
 * Composio server that didn't answer): `resource.unavailable` for this
 * request, but nothing is known to have changed, so a held call of the
 * binding keeps waiting instead of being dropped as stale
 * (`isProviderUnreachable`).
 */
export const providerUnreachable = () =>
  operationErrors.create("resource.unavailable", { transient: true });

/** Whether `error` is {@link providerUnreachable}'s. */
export const isProviderUnreachable = (error: unknown): boolean =>
  operationErrors.codeOf(error) === "resource.unavailable" &&
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
   * Who the audit log names as making each request, and whose budgets a
   * model request counts against besides the binding's own: the App, for
   * a screen's or an agent's call (`delegateActorOf`); the workflow run,
   * for a run's (`runActorOf`), so its workflow and run lineage budgets
   * apply too.
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
   * For a workflow run's call: whose person share of the model requests in
   * flight it takes, from the run's row (workflows/dispatcher.ts): who
   * started it, or its App's triggers' for a run nobody started. Not who
   * it acts for: such a run acts for the App's owner, and never takes the
   * owner's share.
   */
  readonly shareSubject?: string;
  /**
   * For a workflow run's call: throws, synchronously, once the run's
   * step attempt no longer holds its lease. An adapter runs it last
   * before its side effect leaves core (connect's call, the provider
   * request), with nothing awaited in between, so a cancel landing while
   * it prepared the request stops it. A screen's or agent's call has its
   * gate (`authorize`) only.
   */
  readonly requireHolds?: () => void;
  /**
   * The invocation's own gate (`Invocation.authorize`): throws once the
   * caller may no longer act (the release revoked, a role lost, an
   * agent's permission or a step's lease gone). The operation host runs
   * it before each request; an adapter whose request commits later, a
   * shared store's mutation (resource-store.ts), runs it again just
   * before that commit.
   */
  readonly admit?: () => Promise<unknown>;
  /**
   * For a workflow run's call: the step it was made from, by the step's
   * idempotency key and the attempt (its lease ID, never the isolate's),
   * which statistics points it records are kept by until that attempt
   * completes the step (statistics.ts, `recordStatistic`). `recording`
   * runs before a point is kept, so the step adds them up then.
   */
  readonly step?: {
    readonly key: string;
    readonly attempt: string;
    readonly recording: () => void;
  };
  /**
   * What the invocation has used of the bounds an adapter holds it to per
   * invocation, by the adapter's own names (resource-statistics.ts): one
   * map for the whole invocation, whichever of its requests resolved its
   * binding (`resourceBindingsFor` makes it).
   */
  readonly counts?: Map<string, number>;
  /**
   * The Apps whose calls this invocation was made through, its own App
   * last (resource-apps.ts): a call of another App's function refuses one
   * already in it, and one past the deepest chain.
   */
  readonly chain?: readonly AppId[];
  /**
   * Calls a public function of another App as a screen's call of it runs,
   * for `by`, carrying the chain and the caller's own checks
   * (app-functions.ts, `callFunction`): given by core's invocation, so an
   * app resource reaches the called App only as that does.
   */
  readonly callApp?: AppFunctionCall;
  /**
   * Whether this invocation is a workflow run's, or was called, through
   * other Apps, from one (resource-apps.ts): the Apps it calls start no
   * workflows, as a run's own call starts none (a run starting another
   * is a child run of its own, within its lineage's limits).
   */
  readonly fromRun?: boolean;
  /**
   * The agent whose call this invocation is, or was called, through other
   * Apps, from (agent-apps.ts): named on what the Apps it calls start, and
   * on the record of each call.
   */
  readonly agent?: CallingAgent;
  /**
   * How many calls of other Apps' functions the whole call this
   * invocation belongs to has made, its first App's included: one count
   * down the chain, so a call can't fan out past `appCallLimits.calls`.
   */
  readonly appCalls?: { used: number };
  /**
   * For an invocation called, through other Apps, from a workflow run's
   * (resource-apps.ts): the run, as the audit log names it, and whose
   * person share of the model requests in flight it takes. A model
   * request down the chain is the run's (resource-model.ts): it counts
   * against the run's workflow and lineage budgets, and meets the rules
   * for its workflow, besides the called App's own binding caps.
   */
  readonly runOrigin?: RunOrigin;
  /**
   * Aborted once the person cancels the screen's call this invocation is
   * part of (`CallOptions.cancelled`): the Apps it calls stop with it.
   */
  readonly cancelled?: AbortSignal;
}

/** The workflow run a chain of calls between Apps started from. */
export interface RunOrigin {
  readonly actor: AuditActor;
  readonly shareSubject?: string;
}

/** How an app resource calls another App's function (`BindingCaller.callApp`). */
export type AppFunctionCall = (
  by: {
    readonly userId: string;
    readonly role: Role;
    readonly teams: Identity["teams"];
  },
  app: AppId,
  request: string,
  options: {
    readonly deadline: number;
    readonly stillAllowed: () => Promise<void>;
    readonly parentSession?: string;
    readonly chain: readonly AppId[];
    readonly fromRun: boolean;
    readonly agent?: CallingAgent;
    readonly appCalls: { used: number };
    /** For a run's chain: its lease, checked just before each commit. */
    readonly requireHolds?: () => void;
    /** For a run's chain: the run (`BindingCaller.runOrigin`). */
    readonly runOrigin?: RunOrigin;
    /** The calling invocation's cancellation (`BindingCaller.cancelled`). */
    readonly cancelled?: AbortSignal;
    /**
     * The calling invocation's sources (`BindingCaller.sources`), which
     * the called function reads into and its model and connector requests
     * are judged by: what the caller read, an EU-only or sensitive
     * connection's data included, is in what it may pass on.
     */
    readonly sources: InvocationSources;
  }
) => Promise<{
  readonly result: OperationResult;
  readonly provenance: InvocationProvenance | null;
}>;

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

/**
 * What the binding's row says beyond its pin, as read for this request:
 * the alias it binds and, for a model, its own caps (model-budgets.ts).
 */
export interface BindingRecord {
  readonly alias: string;
  readonly budget: ModelBindingBudget | null;
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
   * active grant, a model the deployment allows, a published template
   * version of the declared contract; with the contract it serves now.
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
