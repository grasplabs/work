import { versionErrors } from "@grasp-os/shared/app-releases";
import { delegateActorOf, runActorOf } from "@grasp-os/shared/audit";
import { internalErrors, isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, RunId, StoreId, WorkflowId } from "@grasp-os/shared/ids";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import {
  categoryOf,
  isRetryableCode,
  operationErrors,
} from "@grasp-os/shared/operations";
import type {
  AppErrorPayload,
  OperationResult,
} from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Identity } from "@grasp-os/shared/rpc";
import { coreStepPrefix, stepIdempotencyKey } from "@grasp-os/shared/workflows";
import { z } from "zod";

import { operationRoles } from "./app-access.ts";
import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { callTimeoutMs } from "./app.ts";
import { appFor } from "./apps.ts";
import { memberRole } from "./auth/identity.ts";
import { openStore } from "./data-stores.ts";
import type { OpenStore } from "./data-stores.ts";
import { callOperation } from "./operations.ts";
import type {
  Invocation,
  ProgressSink,
  ResourceBindings,
} from "./operations.ts";
import { requireApprovedVersion } from "./permissions.ts";
import { hostedRelease, noStore, requireNotRevoked } from "./release-runner.ts";
import { invocationSources } from "./resource-adapter.ts";
import type {
  InvocationProvenance,
  InvocationSources,
} from "./resource-adapter.ts";
import { resourceBindingsFor } from "./resource-bindings.ts";

// Calling an App's server functions (spec 6, 8, 16, 32.6): who a call is
// for, which release it runs and what it may reach, resolved by core and
// never by a request. The release runs as release-runner.ts runs it; its
// threat model is there.

/** What core resolved of the caller, for an invocation. */
interface FunctionCaller {
  readonly by: Pick<Identity, "userId" | "role">;
  readonly requestId: string;
  readonly deadline: number;
  /**
   * What else must still hold before every protected step, for a caller
   * whose call core admitted on more than the person's role (an agent's
   * permission, agent-apps.ts): throws once it doesn't.
   */
  readonly stillAllowed?: () => Promise<void>;
  /** What the invocation reads through its resources is noted here. */
  readonly sources?: InvocationSources;
}

/**
 * The invocation of `release` for `caller`: the store from the release
 * alone, the principal and roles from core's identity of the caller,
 * never from a request.
 */
export const invocationFor = async (
  env: Env,
  release: Release,
  {
    by,
    requestId,
    deadline,
    stillAllowed,
    sources = invocationSources(),
  }: FunctionCaller
): Promise<Invocation> => {
  // SAFETY: a release's resource ID is the App it was sealed for.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const app = release.manifest.resourceId as AppId;
  const authority: Authority = {
    subject: { type: "app", appId: app },
    onBehalfOf: by.userId,
    mode: "interactive",
    appVersion: release.manifest.resourceVersion,
  };
  // Before every protected step: the call starts, each mutation commits
  // and each resource request (the operation host's one gate, `admit`).
  // A release revoked, a role lost or an agent's permission withdrawn
  // meanwhile stops a call already running.
  const authorize = async () => {
    await requireNotRevoked(env, app, release.manifest.resourceVersion);
    await stillAllowed?.();
    return await operationRoles(env, by, app);
  };
  const bindings = resourceBindingsFor(env, {
    app,
    authority,
    context: { type: "app", appId: app },
    sources,
    actor: delegateActorOf(authority),
    admit: authorize,
  });
  return {
    principal: by.userId,
    consumer: {
      resourceId: app,
      resourceVersion: release.manifest.resourceVersion,
    },
    store:
      release.store === null
        ? noStore()
        : await openStore(env, release.store.storeId),
    requestId,
    deadline,
    runId: null,
    authorize,
    // The App's approved bindings, read again on every request, acting
    // for the App and the person calling, with the person there. The
    // operation host admits each request through `authorize` first, as it
    // admits each commit, so nothing else is checked here.
    resources: bindings,
  };
};

/** What core resolved of a workflow run calling a function of its App. */
export interface RunCaller {
  /** The run, as its host loaded it: never anything its isolate sent. */
  readonly run: {
    readonly app: AppId;
    readonly workflow: WorkflowId;
    readonly runId: RunId;
    readonly rootRunId?: RunId;
    /** The version the run is pinned to: the release that runs. */
    readonly version: number;
    /** Who the run acts for in this execution, in workflow mode. */
    readonly authority: Authority;
    /** Whose share its model requests take (workflows/host.ts, `HostedRun`). */
    readonly shareSubject: string;
  };
  readonly requestId: string;
  readonly deadline: number;
  /**
   * Throws once the step's attempt the call comes from no longer holds
   * its lease: it timed out, the run was cancelled or paused, another
   * activation took over, or its function returned.
   */
  readonly stillCurrent: () => Promise<void>;
  /**
   * The same, synchronously: for the last check before an effect, with
   * nothing awaited between it and the effect's start.
   */
  readonly requireHolds: () => void;
  /** Hears each side effect connect held for the person (`BindingCaller.held`). */
  readonly held: (key: string) => void;
}

/**
 * `bindings` for a run: each request's key under the run's
 * (`stepIdempotencyKey`), behind core's own prefix, so no step's own key
 * is ever one of them, and connect finds a run's held side effects, and
 * drops them once the run has ended, by the run their key names
 * (pending-actions.ts, workflows/retention.ts). Under it is still the key
 * the operation host derived, so the same call made again sends the same
 * key. The attempt's lease is checked once more as the binding is
 * resolved, with nothing awaited between that and the request's start
 * (`resourceCall`, operations.ts): a cancel landing during the gate's or
 * the binding's reads stops it.
 */
const keyedUnderRun =
  (
    bindings: ResourceBindings,
    runId: RunId,
    requireHolds: () => void
  ): ResourceBindings =>
  async (declaration) => {
    const bound = await bindings(declaration);
    requireHolds();
    return bound === undefined
      ? undefined
      : {
          ...bound,
          call: async (method, args, context) =>
            await bound.call(method, args, {
              ...context,
              idempotencyKey: stepIdempotencyKey(
                runId,
                `${coreStepPrefix}${context.idempotencyKey}`
              ),
            }),
        };
  };

/**
 * `store`, its commits made only while the attempt still holds its lease,
 * checked with nothing awaited between that and the commit.
 */
const fencedStore = (
  store: OpenStore,
  requireHolds: () => void
): OpenStore => ({
  ...store,
  commit: async (commit) => {
    requireHolds();
    return await store.commit(commit);
  },
});

/**
 * The invocation of `release` (the run's own App, at the version the run
 * is pinned to) for a step of `caller`'s run: as the person the run acts
 * for, in workflow mode, with the run as its work context, and with the
 * run as whoever the audit log names and whose budgets a model request
 * counts against besides its binding's (`BindingCaller.actor`). Nothing
 * of it comes from the run's isolate.
 */
export const runInvocationFor = async (
  env: Env,
  release: Release,
  { run, requestId, deadline, stillCurrent, requireHolds, held }: RunCaller
): Promise<Invocation> => {
  const { app, runId, version, authority } = run;
  // The one gate, as for a screen's call: before the call starts, each
  // mutation commits and each resource request. The release; the version
  // an admin approved, while the App holds a permission that changes
  // things (`requireApprovedVersion`), as a run's calls into the App
  // always were: a run waiting on a version nobody approved does nothing
  // more once an admin grants for a later one, not even to the App's own
  // data. Then the person, still a member with a role in the App; then,
  // last, after every read, the step's attempt, so nothing runs for an
  // attempt the engine let go of meanwhile. The commit and the request
  // check the lease once more, synchronously, just before they start.
  const authorize = async () => {
    await requireNotRevoked(env, app, version);
    await requireApprovedVersion(env, app, version);
    const role = await memberRole(env.DB, authority.onBehalfOf);
    if (role === undefined) {
      throw permissionErrors.create("permission.person_inactive");
    }
    const roles = await operationRoles(
      env,
      { userId: authority.onBehalfOf, role },
      app
    );
    await stillCurrent();
    return roles;
  };
  const bindings = resourceBindingsFor(env, {
    app,
    authority: { ...authority, mode: "workflow", appVersion: version },
    context: { type: "run", appId: app, runId },
    sources: invocationSources(),
    actor: runActorOf(run),
    held,
    shareSubject: run.shareSubject,
    requireHolds,
    admit: authorize,
  });
  return {
    principal: authority.onBehalfOf,
    consumer: { resourceId: app, resourceVersion: version },
    store:
      release.store === null
        ? noStore()
        : fencedStore(
            await openStore(env, release.store.storeId),
            requireHolds
          ),
    requestId,
    deadline,
    runId,
    authorize,
    resources: keyedUnderRun(bindings, runId, requireHolds),
  };
};

/**
 * The public function `reference` names in `release`, of its kind: an
 * internal one is refused as one that doesn't exist.
 */
const publicFunctionOf = (
  release: Release,
  reference: { readonly contractId: string; readonly kind: string }
) => {
  const operation = Object.hasOwn(release.app.operations, reference.contractId)
    ? release.app.operations[reference.contractId]
    : undefined;
  if (operation === undefined || operation.visibility !== "public") {
    throw operationErrors.create("operation.not_found");
  }
  if (operation.kind !== reference.kind) {
    throw operationErrors.create("operation.kind_mismatch");
  }
  return operation;
};

const encoder = new TextEncoder();

/** Whether `text` is more than `max` bytes as UTF-8, read no further than needed. */
const isOverBytes = (text: string, max: number): boolean =>
  text.length > max ||
  (text.length * 3 > max && encoder.encode(text).byteLength > max);

/** A call's request, as a screen or agent sends it (spec 32.6). */
const functionRequestSchema = z.strictObject({
  reference: z.strictObject({
    resourceId: z.string().min(1).max(128),
    resourceVersion: z.int().min(1),
    contractId: z.string().min(1).max(256),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    kind: z.enum(["query", "mutation", "action"]),
  }),
  input: z.unknown(),
  idempotencyKey: z.string().optional(),
});

/** A call's request, read. */
export type FunctionRequest = z.infer<typeof functionRequestSchema>;

/**
 * The call `request` (its JSON text, as its caller sent it), bounded
 * before it is read: `contract.input_too_large` past the bound, and
 * `contract.invalid_request` for anything that isn't a call.
 */
export const readFunctionRequest = (request: unknown): FunctionRequest => {
  if (typeof request !== "string") {
    throw operationErrors.create("contract.invalid_request");
  }
  if (isOverBytes(request, functionRequestMaxBytes)) {
    throw operationErrors.create("contract.input_too_large", {
      maxBytes: functionRequestMaxBytes,
    });
  }
  try {
    return functionRequestSchema.parse(JSON.parse(request));
  } catch {
    throw operationErrors.create("contract.invalid_request");
  }
};

/**
 * The path of the public function `reference` names exactly in
 * `release`: refused as one that doesn't exist (`operation.not_found`)
 * when there is none or it is internal, `operation.kind_mismatch` for
 * another kind, and `version.mismatch` for another App, version or
 * contract than the release's.
 */
export const publicOperationOf = (
  release: Release,
  reference: FunctionRequest["reference"]
): string => {
  const operation = Object.hasOwn(release.app.operations, reference.contractId)
    ? release.app.operations[reference.contractId]
    : undefined;
  // An internal function is refused as one that doesn't exist.
  if (operation === undefined || operation.visibility !== "public") {
    throw operationErrors.create("operation.not_found");
  }
  if (operation.kind !== reference.kind) {
    throw operationErrors.create("operation.kind_mismatch");
  }
  if (
    reference.resourceId !== release.manifest.resourceId ||
    reference.resourceVersion !== release.manifest.resourceVersion ||
    release.fingerprints[operation.path] !== reference.fingerprint
  ) {
    throw versionErrors.create("version.mismatch");
  }
  return operation.path;
};

/** What a call answers (spec 32.6). */
export interface FunctionAnswer {
  readonly result: OperationResult;
  /**
   * Where what the call read through its resources comes from, with its
   * classification (spec 32.3): the Knowledge collections, and whether
   * any was sensitive or restricted, and each connection read from with
   * the resources its connector named. Null when no function ran.
   */
  readonly provenance: InvocationProvenance | null;
  /** The fingerprint of the contract that ran, when one did. */
  readonly fingerprint: string | null;
  /** The release that ran, when one did. */
  readonly manifestHash: string | null;
}

/** `error` as the caller may see it, before any function ran. */
export const refusalOf = (
  error: unknown,
  requestId: string
): AppErrorPayload => {
  const expected = isExpectedError(error)
    ? error
    : internalErrors.create("internal.unexpected", { requestId });
  return {
    code: expected.code,
    message: expected.message,
    category: categoryOf(expected.code),
    retryable: isRetryableCode(expected.code),
    requestId,
  };
};

/** How a call of an App's function is made, beyond who and what. */
interface FunctionCallOptions {
  readonly deadline: number;
  readonly stillAllowed?: () => Promise<void>;
  /** The sandbox session (its call ID) of the Code Mode run that calls. */
  readonly parentSession?: string;
  /** Only this kind of function may be called (a live query's). */
  readonly kind?: FunctionRequest["reference"]["kind"];
  /** Told the store a query read and its read set (`Invocation.observeReads`). */
  readonly observeReads?: (
    storeId: StoreId,
    readSet: Record<string, number>
  ) => void;
}

/** `callAppFunction`, with all of its options. */
const callFunction = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: unknown,
  request: unknown,
  options: FunctionCallOptions
): Promise<FunctionAnswer> => {
  const { deadline, stillAllowed, parentSession, kind, observeReads } = options;
  const requestId = crypto.randomUUID();
  const refused = (error: unknown): FunctionAnswer => ({
    result: { ok: false, error: refusalOf(error, requestId) },
    provenance: null,
    fingerprint: null,
    manifestHash: null,
  });
  let call: FunctionRequest;
  try {
    call = readFunctionRequest(request);
    if (kind !== undefined && call.reference.kind !== kind) {
      throw operationErrors.create("contract.invalid_request");
    }
  } catch (error) {
    return refused(error);
  }
  let release: Release;
  let path: string;
  try {
    // Anyone without a role in the App learns nothing of it.
    const found = await appFor(env, by, app, "user");
    if (found.currentVersion === null) {
      throw versionErrors.create("version.not_sealed");
    }
    // The release of the App's current version: its manifest names the
    // App and the version the reference must name.
    release = await loadRelease(env, found.id, found.currentVersion);
    path = publicOperationOf(release, call.reference);
  } catch (error) {
    return refused(error);
  }
  try {
    const sources = invocationSources();
    const invocation = await invocationFor(env, release, {
      by,
      requestId,
      deadline,
      ...(stillAllowed === undefined ? {} : { stillAllowed }),
      sources,
    });
    const { store } = release;
    const result = await callOperation(
      hostedRelease(env, release),
      observeReads === undefined || store === null
        ? invocation
        : {
            ...invocation,
            observeReads: (readSet) => {
              observeReads(storeIdSchema.parse(store.storeId), readSet);
            },
          },
      { path, kind: call.reference.kind },
      call.input,
      {
        ...(call.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: call.idempotencyKey }),
        ...(parentSession === undefined ? {} : { parentSession }),
      }
    );
    return {
      result,
      provenance: sources.snapshot(),
      fingerprint: call.reference.fingerprint,
      manifestHash: release.manifestHash,
    };
  } catch (error) {
    return refused(error);
  }
};

/**
 * Calls a public function of App `app` for `by` (spec 32.6): `request`
 * is the call as its caller sent it, as text, bounded before it is read.
 * It runs only against the release of the App's current version, and
 * only if its reference names exactly a public function there (see the
 * header); then through the operation host, which decides the rest.
 * Never throws.
 */
export const callAppFunction = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: unknown,
  request: unknown,
  deadline = Date.now() + platformLimits.serverInvocationWallMs,
  stillAllowed?: () => Promise<void>,
  /** The sandbox session (its call ID) of the Code Mode run that calls. */
  parentSession?: string
): Promise<FunctionAnswer> =>
  await callFunction(env, by, app, request, {
    deadline,
    ...(stillAllowed === undefined ? {} : { stillAllowed }),
    ...(parentSession === undefined ? {} : { parentSession }),
  });

/** What a live query's evaluation answered, and what it read. */
export interface EvaluatedQuery {
  readonly answer: FunctionAnswer;
  /**
   * The store it read and the generation of each table it read, once its
   * reads stood as one state of the store; none when it read no store
   * (it failed before it ran, or its App has none).
   */
  readonly reads:
    | { readonly storeId: StoreId; readonly readSet: Record<string, number> }
    | undefined;
}

/**
 * Evaluates a public query of App `app` for `by`, as `callAppFunction`
 * calls it, refusing any other kind (`contract.invalid_request`), and
 * answers what it read with its answer: a live query's evaluation
 * (query-subscriptions.ts). Never throws.
 */
export const evaluateAppQuery = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: unknown,
  request: string,
  deadline: number
): Promise<EvaluatedQuery> => {
  let reads: EvaluatedQuery["reads"];
  const answer = await callFunction(env, by, app, request, {
    deadline,
    kind: "query",
    observeReads: (storeId, readSet) => {
      reads = { storeId, readSet };
    },
  });
  return { answer, reads };
};

/**
 * Runs a public action of App `app` for `by` once, for the invocation
 * object that holds it (action-invocation.ts), as `callAppFunction` runs
 * any call: what it returned, or why it failed, and whether the operation
 * host was reached at all (a refusal before it ran nothing of the App's). A streaming action
 * (spec 10.7.6) gets `progress`, where its snapshots go, and only one
 * does; `cancelled` stops either. Never throws.
 */
export const invokeAppAction = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: string,
  call: FunctionRequest,
  {
    progress,
    cancelled,
    deadline,
  }: {
    readonly progress?: ProgressSink;
    readonly cancelled: AbortSignal;
    readonly deadline: number;
  }
): Promise<{
  readonly result: OperationResult;
  /** Whether the operation host was reached: App code may have run. */
  readonly reached: boolean;
  /** How many effects it made, or may have made (`CallOptions.onEffect`). */
  readonly effects: number;
}> => {
  const requestId = crypto.randomUUID();
  let reached = false;
  let effects = 0;
  try {
    const found = await appFor(env, by, app, "user");
    if (found.currentVersion === null) {
      throw versionErrors.create("version.not_sealed");
    }
    const release = await loadRelease(env, found.id, found.currentVersion);
    const path = publicOperationOf(release, call.reference);
    const invocation = await invocationFor(env, release, {
      by,
      requestId,
      deadline,
    });
    reached = true;
    const result = await callOperation(
      hostedRelease(env, release),
      invocation,
      { path, kind: call.reference.kind },
      call.input,
      {
        ...(call.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: call.idempotencyKey }),
        ...(progress === undefined ? {} : { progress }),
        cancelled,
        onEffect: () => {
          effects += 1;
        },
      }
    );
    return { result, reached, effects };
  } catch (error) {
    return {
      result: { ok: false, error: refusalOf(error, requestId) },
      reached,
      effects,
    };
  }
};

/**
 * A function as a workflow step names it: a generated reference, or just
 * its path and kind. Only those are read; a reference's App, version and
 * fingerprint, where it has them, must be exactly the run's.
 */
const runReferenceSchema = z.object({
  contractId: z.string().min(1).max(256),
  kind: z.enum(["query", "mutation", "action"]),
  resourceId: z.string().min(1).max(128).optional(),
  resourceVersion: z.int().min(1).optional(),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});

/**
 * Calls a public function of a workflow run's own App for one of its
 * steps (`env.APP.callFunction`, workflows/host.ts): only in the release
 * of the version the run is pinned to, as the run (`runInvocationFor`),
 * under `idempotencyKey`, which core derived from the step's. What it
 * answers, or why it failed, as a screen's call gets it (spec 32.6).
 * Never throws.
 */
export const callRunFunction = async (
  env: Env,
  caller: RunCaller,
  reference: unknown,
  input: unknown,
  idempotencyKey: string
): Promise<OperationResult> => {
  const { app, version } = caller.run;
  try {
    const named = runReferenceSchema.safeParse(reference);
    if (!named.success) {
      throw operationErrors.create("contract.invalid_request");
    }
    const release = await loadRelease(env, app, version);
    const operation = publicFunctionOf(release, named.data);
    const { resourceId, resourceVersion, fingerprint } = named.data;
    // Another App's function, another version's or another contract's:
    // refused before any of its input is read.
    if (
      (resourceId !== undefined && resourceId !== app) ||
      (resourceVersion !== undefined && resourceVersion !== version) ||
      (fingerprint !== undefined &&
        release.fingerprints[operation.path] !== fingerprint)
    ) {
      throw versionErrors.create("version.mismatch");
    }
    return await callOperation(
      hostedRelease(env, release),
      await runInvocationFor(env, release, {
        ...caller,
        // No longer than the step's attempt, nor than any call of an App's.
        deadline: Math.min(caller.deadline, Date.now() + callTimeoutMs(env)),
      }),
      { path: operation.path, kind: operation.kind },
      input,
      { idempotencyKey }
    );
  } catch (error) {
    return { ok: false, error: refusalOf(error, caller.requestId) };
  }
};
