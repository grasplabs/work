import { declaredPermission } from "@grasp-os/runtime/host";
import type {
  FunctionManifest,
  WorkflowQueryName,
} from "@grasp-os/runtime/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { internalErrors, isExpectedError } from "@grasp-os/shared/errors";
import { functionRequestMaxBytes } from "@grasp-os/shared/function-limits";
import {
  categoryOf,
  isRetryableCode,
  functionErrors,
} from "@grasp-os/shared/functions";
import type {
  AppErrorPayload,
  FunctionResult,
} from "@grasp-os/shared/functions";
import {
  agentIdSchema,
  appIdSchema,
  storeIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WriterRoles } from "@grasp-os/shared/stores";
import { waitUntil } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { functionRoles } from "./app-access.ts";
import { appPeopleNotifications } from "./app-notifications.ts";
import {
  answerPeople,
  isPeoplePath,
  memberPeople,
  peopleReadOf,
  visitorPeople,
} from "./app-people.ts";
import type { PeopleAccess } from "./app-people.ts";
import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import {
  formHeardBy,
  formIntents,
  formSubmissionOf,
} from "./app-webhook-queue.ts";
import { releaseFunctionsOf, usableApp } from "./apps.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { openStore } from "./data-stores.ts";
import { hostFunctionCall } from "./function-host.ts";
import type { Invocation, ProgressSink, UseRefusal } from "./function-host.ts";
import {
  answerWorkflowMutation,
  isWorkflowMutationPath,
} from "./page-workflows.ts";
import { hostedRelease, noStore, requireNotRevoked } from "./release-runner.ts";
import { invocationSources } from "./resource-adapter.ts";
import type {
  InvocationProvenance,
  InvocationSources,
} from "./resource-adapter.ts";
import { resourceBindingsFor } from "./resource-bindings.ts";
import { keptSensitiveReads } from "./sensitive-reads.ts";
import { appWorkflowEventSends } from "./workflow-event-sends.ts";
import {
  callWorkflowQuery,
  isDecisionQueryPath,
  isWorkflowQueryPath,
  workflowQueryOf,
} from "./workflow-reference-queries.ts";
import type {
  ResolvedWorkflowQuery,
  WorkflowQueryCaller,
} from "./workflow-reference-queries.ts";
import { appWorkflowStarts } from "./workflow-start-intents.ts";
import type { CallingAgent } from "./workflow-start-intents.ts";

// Calling an App's server functions (spec 6, 8, 16, 32.6): who a call is
// for, which release it runs and what it may reach, resolved by core and
// never by a request. The release runs as release-runner.ts runs it; its
// threat model is there.

/** What core resolved of the caller, for an invocation. */
interface FunctionCaller {
  readonly by: Pick<Identity, "userId" | "role"> &
    Partial<Pick<Identity, "teams">>;
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
  /**
   * The agent whose call this is (a chat's code, agent-apps.ts): named on
   * the workflows the call starts, and whose permission on the App a start
   * it stages needs again when it is dispatched.
   */
  readonly agent?: CallingAgent;
  /**
   * The refused uses a live query's subscription kept already, for one of
   * its reads (`Invocation.refusalsKept`).
   */
  readonly refusalsKept?: Set<string>;
}

/** A visitor as the audit log names them: by their session once signed in. */
type VisitorActor = Extract<AuditActor, { type: "visitor" }>;

/**
 * Whose call a refused use's evidence names (`keptUseRefusals`): a
 * member's as the App's server code acting for `person`; a visitor's as
 * the visitor, by their session, as the log names them for their other
 * actions (app-visitors.ts), with no person, nor anything else of them.
 */
type UseRefusalContext = {
  readonly app: AppId;
  readonly version: number;
  readonly requestId: string;
  readonly runId: string | null;
} & ({ readonly person: string } | { readonly visitor: VisitorActor });

/** Writes `refusal` as `app.use.refused` for `context`; never throws (`keepAuditEvent`). */
const writeUseRefusal = async (
  env: Env,
  context: UseRefusalContext,
  refusal: UseRefusal
): Promise<void> => {
  const { app, version, requestId, runId } = context;
  const member = "person" in context;
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: member
      ? { type: "app", appId: app, part: "server" }
      : context.visitor,
    action: "app.use.refused",
    target: { type: "app", id: app },
    requestId,
    detail: {
      version,
      ...(member ? { person: context.person } : {}),
      runId,
      function: refusal.function,
      useKind: refusal.use.kind,
      useName: refusal.use.name,
      reason: refusal.reason,
      errorCode: refusal.errorCode,
    },
  });
};

/**
 * How a real call of App `app`'s version `version` keeps the evidence of a
 * use its code asked for that its sealed manifest doesn't allow
 * (function-host.ts, `Invocation.refusedUse`; GRA-279): `app.use.refused`, as
 * the App's server code acting for `principal`, every field core's own.
 * The write is the request's own work until it is kept: the host waits for
 * it only so long (`useEvidenceWaitMs`), and one it stopped waiting for
 * still finishes rather than ending with the call. One that can't be kept
 * is logged; the refusal stands either way.
 */
const keptUseRefusals =
  (env: Env, context: UseRefusalContext) =>
  async (refusal: UseRefusal): Promise<void> => {
    const writing = writeUseRefusal(env, context, refusal);
    waitUntil(writing);
    await writing;
  };

/**
 * Who makes a call core resolved for `person`, as the audit log names
 * them: the agent acting for them, else the person.
 */
const callerActor = (person: string, agent?: CallingAgent): AuditActor =>
  agent === undefined
    ? { type: "person", userId: person }
    : { type: "agent", agentId: agent.agentId, onBehalfOf: person };

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
    agent,
    refusalsKept,
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
  // and each resource request (the function host's one gate, `admit`).
  // A release revoked, a role lost or an agent's permission withdrawn
  // meanwhile stops a call already running.
  // The roles the gate read last, which who calls is told (`people`).
  let admitted: WriterRoles | undefined;
  const authorize = async () => {
    await requireNotRevoked(env, app, release.manifest.resourceVersion);
    await stillAllowed?.();
    admitted = await functionRoles(env, by, app);
    return admitted;
  };
  const bindings = resourceBindingsFor(env, {
    app,
    authority,
    context: { type: "app", appId: app },
    sources,
    actor: delegateActorOf(authority),
    admit: authorize,
  });
  const store =
    release.store === null
      ? noStore()
      : await openStore(env, release.store.storeId);
  const actor = callerActor(by.userId, agent);
  return {
    principal: by.userId,
    actor,
    sensitiveReads: keptSensitiveReads(env, {
      actor,
      target: { type: "app", id: app },
      version: release.manifest.resourceVersion,
      principal: by.userId,
      requestId,
      runId: null,
    }),
    consumer: {
      resourceId: app,
      resourceVersion: release.manifest.resourceVersion,
    },
    // Who calls: the person core resolved, their roles in the App read as
    // the gate reads them.
    people: memberPeople(env, {
      app,
      userId: by.userId,
      roles: async () => admitted ?? (await authorize()),
      declared:
        declaredPermission(release.app, "people", "people") !== undefined,
      actor: delegateActorOf(authority),
      requestId,
    }),
    store,
    requestId,
    deadline,
    runId: null,
    authorize,
    refusedUse: keptUseRefusals(env, {
      app,
      version: release.manifest.resourceVersion,
      person: by.userId,
      requestId,
      runId: null,
    }),
    ...(refusalsKept === undefined ? {} : { refusalsKept }),
    // The App's approved bindings, read again on every request, acting
    // for the App and the person calling, with the person there. The
    // function host admits each request through `authorize` first, as it
    // admits each commit, so nothing else is checked here.
    resources: bindings,
    // The workflows the App binds, started as the App for the person
    // calling: each start admitted on the App's own grant and the
    // person's role in the App, read again as it is admitted.
    workflows: appWorkflowStarts(env, authority, agent ?? null),
    // The events a mutation sends the App's runs, likewise.
    eventSends: appWorkflowEventSends(env, authority, release, agent ?? null),
    // The people the App tells, through the platform's notifications, as
    // the App for the person calling.
    notifyPeople: appPeopleNotifications(env, authority, agent ?? null),
  };
};

const encoder = new TextEncoder();

/** Whether `text` is more than `max` bytes as UTF-8, read no further than needed. */
const isOverBytes = (text: string, max: number): boolean =>
  text.length > max ||
  (text.length * 3 > max && encoder.encode(text).byteLength > max);

/** A call's request, as a page or agent sends it (spec 32.6). */
const functionRequestSchema = z.strictObject({
  // A function's name and kind, nothing more: resolved in the release
  // that answers the call, the App's current one for a page.
  reference: z.strictObject({
    name: z.string().min(1).max(256),
    kind: z.enum(["query", "mutation", "action"]),
  }),
  args: z.unknown(),
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
    throw functionErrors.create("contract.invalid_request");
  }
  if (isOverBytes(request, functionRequestMaxBytes)) {
    throw functionErrors.create("contract.input_too_large", {
      maxBytes: functionRequestMaxBytes,
    });
  }
  try {
    return functionRequestSchema.parse(JSON.parse(request));
  } catch {
    throw functionErrors.create("contract.invalid_request");
  }
};

/**
 * The path of the public function `reference` names in `release`, the
 * release that answers the call: refused as one that doesn't exist
 * (`function.not_found`) when there is none or it is internal, and
 * `function.kind_mismatch` for another kind. A page's calls always name
 * the App's current release, whatever build it runs (its lease only
 * says who opened it and what core served), so an old page, a replayed
 * lease or a forged name reaches only the current code's public
 * functions, with what their own validators accept; a page whose
 * function is gone hears so and switches to the new version.
 */
export const publicFunctionOf = (
  release: Release,
  reference: FunctionRequest["reference"]
): string => {
  const fn = Object.hasOwn(release.app.functions, reference.name)
    ? release.app.functions[reference.name]
    : undefined;
  // An internal function is refused as one that doesn't exist.
  if (fn === undefined || fn.visibility !== "public") {
    throw functionErrors.create("function.not_found");
  }
  if (fn.kind !== reference.kind) {
    throw functionErrors.create("function.kind_mismatch");
  }
  return fn.path;
};

/** What a call answers (spec 32.6). */
export interface FunctionAnswer {
  readonly result: FunctionResult;
  /**
   * Where what the call read through its resources comes from, with its
   * classification (spec 32.3): the Knowledge collections, and whether
   * any was sensitive or restricted, and each connection read from with
   * the resources its connector named. Null when no function ran.
   */
  readonly provenance: InvocationProvenance | null;
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
  // Of its details, only how long to wait before asking again: what a
  // caller needs to wait for its budget.
  const details: unknown = Reflect.get(expected, "details");
  const retryAfterMs: unknown =
    typeof details === "object" && details !== null
      ? Reflect.get(details, "retryAfterMs")
      : undefined;
  return {
    code: expected.code,
    message: expected.message,
    category: categoryOf(expected.code),
    retryable: isRetryableCode(expected.code),
    requestId,
    ...(typeof retryAfterMs === "number" ? { details: { retryAfterMs } } : {}),
  };
};

/** How a call of an App's function is made, beyond who and what. */
interface FunctionCallOptions {
  readonly deadline: number;
  /**
   * Whether a keyed mutation's call is a page's form, told to the App's
   * webhooks: its commit carries it (`CallOptions.commitIntent`), so it is
   * told once it committed, once per submission, and never unless it did.
   * A query, an action or what the mutation calls is never told.
   */
  readonly tellsForm?: boolean;
  /**
   * Whether a person's page calls, or follows it live: only a page reads a
   * run of a workflow reference (`run`, `canStart`, page-workflows.ts),
   * as only a page starts or controls one; an agent's, a Code Mode run's
   * or the App's own server code's call reads no run's output.
   */
  readonly page?: boolean;
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
  /** The agent whose call this is (`FunctionCaller.agent`). */
  readonly agent?: CallingAgent;
  /** What a mutation's receipt is scoped by (`CallOptions.receiptScope`). */
  readonly receiptScope?: string;
  /** A live query's kept refusals (`FunctionCaller.refusalsKept`). */
  readonly refusalsKept?: Set<string>;
}

/**
 * The call `request`, refused as `contract.invalid_request` when it isn't
 * of `kind` (when given).
 */
const callAllowed = (
  request: unknown,
  kind?: FunctionRequest["reference"]["kind"]
): FunctionRequest => {
  const call = readFunctionRequest(request);
  if (kind !== undefined && call.reference.kind !== kind) {
    throw functionErrors.create("contract.invalid_request");
  }
  return call;
};

/**
 * What `reference` names in `release`: a public function's path, or a
 * workflow reference's query, which is core's to answer, never the App's
 * (workflow-reference-queries.ts). No App function shadows one: the SDK
 * keeps the top-level `workflows` segment for the platform, so a release
 * that registers a function there never seals.
 */
const referenceIn = (
  release: Release,
  reference: FunctionRequest["reference"]
): {
  path: string;
  workflowQuery: ResolvedWorkflowQuery | undefined;
} => {
  if (isWorkflowQueryPath(reference.name)) {
    return {
      path: reference.name,
      workflowQuery: workflowQueryOf(release, reference),
    };
  }
  return {
    path: publicFunctionOf(release, reference),
    workflowQuery: undefined,
  };
};

/**
 * The gate a call core answers itself passes before it reads, as late as
 * it can be: the caller's own check (an agent's permission, say), the
 * release not revoked, the person's role in the App, read again now, so a
 * revocation or a role lost since the call began reads nothing; and the
 * call's deadline, as its invocation would hold it.
 */
const coreAnsweredGate =
  (
    env: Env,
    {
      by,
      app,
      release,
      stillAllowed,
      deadline,
    }: {
      by: Pick<Identity, "userId" | "role">;
      app: string;
      release: Release;
      stillAllowed: FunctionCallOptions["stillAllowed"];
      deadline: number;
    }
  ) =>
  async (): Promise<void> => {
    await stillAllowed?.();
    await requireNotRevoked(
      env,
      appIdSchema.parse(app),
      release.manifest.resourceVersion
    );
    await functionRoles(env, by, appIdSchema.parse(app));
    if (Date.now() >= deadline) {
      throw functionErrors.create("function.deadline_exceeded");
    }
  };

/** A workflow reference's query, answered as `callFunction` answers a call. */
const answeredWorkflowQuery = async (
  env: Env,
  {
    by,
    caller,
    query,
    call,
    release,
    refused,
    stillAllowed,
    deadline,
  }: {
    by: Pick<Identity, "userId" | "role">;
    deadline: number;
    caller: WorkflowQueryCaller;
    query: ResolvedWorkflowQuery;
    call: FunctionRequest;
    release: Release;
    refused: (error: unknown) => FunctionAnswer;
    stillAllowed: FunctionCallOptions["stillAllowed"];
  }
): Promise<FunctionAnswer> => {
  try {
    await coreAnsweredGate(env, {
      by,
      app: caller.app,
      release,
      stillAllowed,
      deadline,
    })();
    const result = await callWorkflowQuery(env, caller, query, call.args);
    return {
      result,
      provenance: null,
      manifestHash: release.manifestHash,
    };
  } catch (error) {
    return refused(error);
  }
};

/**
 * A read of who calls or of the organization's people (app-people.ts),
 * as a page of App `app` makes it, answered as `callFunction` answers a
 * call: for the App the call came through (never one its reference
 * names), once the caller passes the gate a call core answers itself
 * passes.
 */
const answeredPeople = async (
  env: Env,
  {
    by,
    app: named,
    call,
    refused,
    stillAllowed,
    deadline,
    requestId,
    agent,
  }: {
    by: Pick<Identity, "userId" | "role" | "teams">;
    app: unknown;
    call: FunctionRequest;
    refused: (error: unknown) => FunctionAnswer;
    stillAllowed: FunctionCallOptions["stillAllowed"];
    deadline: number;
    requestId: string;
    /** The chat's agent making the read, when it is one's. */
    agent: CallingAgent | undefined;
  }
): Promise<FunctionAnswer> => {
  try {
    const read = peopleReadOf(call.reference);
    // Anyone without a role in the App learns nothing of it.
    const found = await usableApp(env, by, named);
    if (found.currentVersion === null) {
      throw versionErrors.create("version.not_sealed");
    }
    const app = appIdSchema.parse(found.id);
    const release = await loadRelease(env, app, found.currentVersion);
    await coreAnsweredGate(env, { by, app, release, stillAllowed, deadline })();
    const value = await answerPeople(
      memberPeople(env, {
        app,
        userId: by.userId,
        roles: async () => await functionRoles(env, by, app),
        declared:
          declaredPermission(release.app, "people", "people") !== undefined,
        // An agent's read is the agent's, for its person; any other is the
        // App's page's.
        actor:
          agent === undefined
            ? { type: "app", appId: app, part: "page" }
            : delegateActorOf({
                subject: {
                  type: "agent",
                  agentId: agentIdSchema.parse(agent.agentId),
                },
                onBehalfOf: by.userId,
                mode: "interactive",
              }),
        requestId,
      }),
      read,
      call.args
    );
    return {
      result: { ok: true, value },
      provenance: null,
      manifestHash: release.manifestHash,
    };
  } catch (error) {
    return refused(error);
  }
};

/** `callAppFunction`, with all of its options. */
/**
 * `invocation`, telling `observeReads` what a query read of `release`'s
 * store, where given.
 */
const observedInvocation = (
  invocation: Invocation,
  release: Release,
  observeReads: FunctionCallOptions["observeReads"]
): Invocation => {
  const { store } = release;
  return {
    ...invocation,
    ...(observeReads === undefined || store === null
      ? {}
      : {
          observeReads: (readSet: Record<string, number>) => {
            observeReads(storeIdSchema.parse(store.storeId), readSet);
          },
        }),
  };
};

/**
 * What `call` of `by`'s names in App `app`'s current release, the one
 * that answers every page's call: refused for anyone without a role in
 * the App, who learns nothing of it, and while no version is current.
 */
const currentResolution = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams"> &
    Partial<Pick<Identity, "staff">>,
  app: unknown,
  call: FunctionRequest
) => {
  const found = await usableApp(env, by, app);
  if (found.currentVersion === null) {
    throw versionErrors.create("version.not_sealed");
  }
  const release = await loadRelease(env, found.id, found.currentVersion);
  const resolved = referenceIn(release, call.reference);
  return { release, appId: found.id, ...resolved };
};

/**
 * `call` of the public function at `path` of `release` (App `appId`'s),
 * as `callFunction` resolved it, run through the function host for `by`:
 * the tail every call of a function shares, by name or by ID.
 */
const invokedCall = async (
  env: Env,
  {
    by,
    release,
    appId,
    path,
    call,
    options,
    requestId,
    sources,
    refused,
  }: {
    by: Pick<Identity, "userId" | "role" | "teams">;
    release: Release;
    appId: AppId;
    path: string;
    call: FunctionRequest;
    options: FunctionCallOptions;
    requestId: string;
    sources: InvocationSources;
    refused: (error: unknown) => FunctionAnswer;
  }
): Promise<FunctionAnswer> => {
  const {
    deadline,
    stillAllowed,
    parentSession,
    observeReads,
    agent,
    tellsForm,
    receiptScope,
    refusalsKept,
  } = options;
  try {
    const invocation = await invocationFor(env, release, {
      by,
      requestId,
      deadline,
      ...(stillAllowed === undefined ? {} : { stillAllowed }),
      ...(agent === undefined ? {} : { agent }),
      ...(refusalsKept === undefined ? {} : { refusalsKept }),
      sources,
    });
    const observed = observedInvocation(invocation, release, observeReads);
    const hosted = hostedRelease(env, release);
    const reference = { path, kind: call.reference.kind };
    // A page's keyed mutation: its form, committed with its writes.
    const submittedCall = call;
    const submittedKey = call.idempotencyKey;
    const submittedApp = appId;
    const result = await hostFunctionCall(
      hosted,
      observed,
      reference,
      call.args,
      {
        ...(call.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: call.idempotencyKey }),
        ...(parentSession === undefined ? {} : { parentSession }),
        ...(receiptScope === undefined ? {} : { receiptScope }),
        ...(tellsForm !== true ||
        submittedCall.reference.kind !== "mutation" ||
        submittedKey === undefined
          ? {}
          : {
              // Only for a form some webhook would hear: a receipt
              // whose outbox owes nothing keeps to its own time.
              // Its values left out when the commit wouldn't hold them.
              commitIntent: async (startedAt: number) =>
                (await formHeardBy(env, submittedApp, startedAt))
                  ? formIntents(
                      formSubmissionOf({
                        app: submittedApp,
                        userId: by.userId,
                        call: submittedCall,
                        key: submittedKey,
                        path,
                        startedAt,
                      })
                    )
                  : undefined,
            }),
      }
    );
    return {
      result,
      provenance: sources.snapshot(),
      manifestHash: release.manifestHash,
    };
  } catch (error) {
    return refused(error);
  }
};

/** A workflow reference's queries only a page reads (`FunctionCallOptions.page`). */
const isPageOnlyQuery = (name: WorkflowQueryName): boolean =>
  name === "run" || name === "canStart";

const callFunction = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams"> &
    Partial<Pick<Identity, "staff">>,
  app: unknown,
  request: unknown,
  options: FunctionCallOptions
): Promise<FunctionAnswer> => {
  const { deadline, stillAllowed, kind, agent } = options;
  const sources = invocationSources();
  const requestId = crypto.randomUUID();
  const refused = (error: unknown): FunctionAnswer => ({
    result: { ok: false, error: refusalOf(error, requestId) },
    provenance: null,
    manifestHash: null,
  });
  let call: FunctionRequest;
  try {
    call = callAllowed(request, kind);
  } catch (error) {
    return refused(error);
  }
  // Who calls, and the organization's people: core's own.
  if (isPeoplePath(call.reference.name)) {
    return await answeredPeople(env, {
      by,
      app,
      call,
      refused,
      stillAllowed,
      deadline,
      requestId,
      agent,
    });
  }
  let resolved: Awaited<ReturnType<typeof currentResolution>>;
  try {
    resolved = await currentResolution(env, by, app, call);
  } catch (error) {
    return refused(error);
  }
  const { release, path, appId, workflowQuery } = resolved;
  if (workflowQuery !== undefined) {
    if (isPageOnlyQuery(workflowQuery.name) && options.page !== true) {
      return refused(functionErrors.create("function.not_found"));
    }
    return await answeredWorkflowQuery(env, {
      by,
      // Staff are asked no client's decision (decisions.ts), whatever
      // membership they hold.
      caller: { app: appId, userId: by.userId, staff: by.staff === true },
      query: workflowQuery,
      call,
      release,
      refused,
      stillAllowed,
      deadline,
    });
  }
  return await invokedCall(env, {
    by,
    release,
    appId,
    path,
    call,
    options,
    requestId,
    sources,
    refused,
  });
};

/**
 * The public function App `app`'s definition gives stable ID `id`, in
 * the release of the App's current version, for `by`: resolved through
 * the definition that release was sealed with (apps.ts,
 * `releaseFunctionsOf`), never by a name a caller holds. `app.not_found`
 * for anyone without a role in the App, `version.not_sealed` while none
 * is current, and `function.not_found` when no public function has the
 * ID.
 */
export const functionById = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: AppId,
  id: string
): Promise<{ release: Release; fn: FunctionManifest }> => {
  const found = await usableApp(env, by, app);
  if (found.currentVersion === null) {
    throw versionErrors.create("version.not_sealed");
  }
  const release = await loadRelease(env, found.id, found.currentVersion);
  const functions = await releaseFunctionsOf(env, release);
  const path = functions.get(id);
  const fn =
    path !== undefined && Object.hasOwn(release.app.functions, path)
      ? release.app.functions[path]
      : undefined;
  if (fn?.visibility !== "public") {
    throw functionErrors.create("function.not_found");
  }
  return { release, fn };
};

/**
 * Calls the public function App `app`'s definition gives stable ID
 * `id`, for `by` (a workflow's run, workflows/app-calls.ts): resolved in
 * the release of the App's current version, through the definition that
 * release was sealed with (apps.ts, `releaseFunctionsOf`), never by a
 * name the caller holds, so a rename since the caller was bound reaches
 * the same function, and a function removed reaches nothing
 * (`function.not_found`). Then as any call: `by` needs a role in the App,
 * the function's own validator checks `input`, and a mutation is keyed by
 * `idempotencyKey`, so a retry or replay answers its stored receipt.
 * Answers the call's request ID too, which the App's own evidence of it
 * names (its sensitive reads, a use it refused). Never throws.
 */
export const callAppFunctionById = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: AppId,
  {
    id,
    input,
    idempotencyKey,
  }: { id: string; input: unknown; idempotencyKey: string },
  options: Pick<FunctionCallOptions, "deadline" | "stillAllowed"> & {
    /**
     * Told the function's kind once it is resolved, right before it
     * runs: throws to run nothing (an action that can't be tried once).
     */
    readonly running: (
      kind: FunctionRequest["reference"]["kind"]
    ) => Promise<void>;
  }
): Promise<
  FunctionAnswer & { readonly path: string | null; readonly requestId: string }
> => {
  const sources = invocationSources();
  const requestId = crypto.randomUUID();
  const refused = (error: unknown) => ({
    requestId,
    result: { ok: false as const, error: refusalOf(error, requestId) },
    provenance: null,
    manifestHash: null,
    path: null,
  });
  let resolved: { release: Release; path: string; call: FunctionRequest };
  try {
    const { release, fn } = await functionById(env, by, app, id);
    const { path } = fn;
    resolved = {
      release,
      path,
      call: {
        reference: { name: path, kind: fn.kind },
        args: input,
        // Only a mutation keeps a receipt to answer a retry from.
        ...(fn.kind === "mutation" ? { idempotencyKey } : {}),
      },
    };
    await options.running(fn.kind);
  } catch (error) {
    return refused(error);
  }
  const answer = await invokedCall(env, {
    by,
    release: resolved.release,
    appId: app,
    path: resolved.path,
    call: resolved.call,
    options: {
      deadline: options.deadline,
      ...(options.stillAllowed === undefined
        ? {}
        : { stillAllowed: options.stillAllowed }),
      // By the ID, never the path a rename changes.
      receiptScope: `function:${id}`,
    },
    requestId,
    sources,
    refused,
  });
  return { ...answer, path: resolved.path, requestId };
};

/**
 * Who a visitor's call runs for (app-visitor-grants.ts): never a person.
 * The App's version is the one it was granted on.
 */
export interface VisitorCaller {
  readonly app: AppId;
  readonly version: number;
  /**
   * `visitor:<session>`, a name no member's ID has: it owns what the call
   * inserts, and keys its receipts, so no two visitors share either.
   */
  readonly principal: string;
  /** The address they signed in with, as their session holds it. */
  readonly email: string;
  /** The visitor, by their session, as the audit log names them. */
  readonly actor: VisitorActor;
  /**
   * Throws unless the visitor may still call `path`: their session live,
   * the App published at this version, their address listed, and `path`
   * still granted. Read before the call and before each commit.
   */
  readonly stillAllowed: (path: string) => Promise<void>;
  /**
   * Refuses the call of `path` as not granted, recorded: for what no grant
   * can open (an action, core's own queries) as for what isn't granted.
   */
  readonly notGranted: (path: string) => Promise<never>;
  /** Told the function the call runs, once it is admitted. */
  readonly admitted: (path: string) => Promise<void>;
}

/**
 * What a visitor is told of people: who they are, and no directory, each
 * read of which is refused as a function no grant opens, and recorded.
 */
const visitorPeopleOf = (caller: VisitorCaller): PeopleAccess =>
  visitorPeople({
    principal: caller.principal,
    email: caller.email,
    refuse: async (name) => await caller.notGranted(`people.${name}`),
  });

/**
 * The invocation of `release`'s function `path` for a visitor: the App's
 * store, as no member (no `appMembers` or `appBuilders` table opens to it,
 * and an `owner` table shows only the visitor's own rows), with nothing
 * else bound. No resource (no connection, Knowledge, model, store, other
 * App or template), no workflow started or sent an event, no one told: a
 * function that asks for any of them is refused (`permission.unavailable`),
 * whatever the App holds for its members.
 */
export const visitorInvocation = async (
  env: Env,
  release: Release,
  caller: VisitorCaller,
  path: string,
  requestId: string,
  deadline: number
): Promise<Invocation> => {
  const store =
    release.store === null
      ? noStore()
      : await openStore(env, release.store.storeId);
  return {
    principal: caller.principal,
    actor: caller.actor,
    sensitiveReads: keptSensitiveReads(env, {
      actor: caller.actor,
      target: { type: "app", id: caller.app },
      version: release.manifest.resourceVersion,
      principal: caller.principal,
      requestId,
      runId: null,
    }),
    consumer: {
      resourceId: caller.app,
      resourceVersion: release.manifest.resourceVersion,
    },
    store,
    requestId,
    deadline,
    runId: null,
    authorize: async () => {
      await requireNotRevoked(env, caller.app, caller.version);
      await caller.stillAllowed(path);
      return { appMember: false, appBuilder: false };
    },
    // What the App's store or the host refuses them, kept as a member's
    // is, at most once a call, naming them by their session alone: no
    // person, no address. Each call was counted against the visitor's
    // and the App's limits before it ran, so a visitor repeating refused
    // calls adds no more to the log than those limits let through.
    refusedUse: keptUseRefusals(env, {
      app: caller.app,
      version: release.manifest.resourceVersion,
      visitor: caller.actor,
      requestId,
      runId: null,
    }),
    people: visitorPeopleOf(caller),
  };
};

/**
 * Calls a function of a published App for a visitor (app-visitor-grants.ts),
 * as the App itself: only a public query or mutation of the version the
 * visitor's grant is on, never an action (which reaches resources) and
 * never core's own workflow queries, which are a member's.
 * `request` is the call as the page client wrote it, as text.
 */
export const callVisitorFunction = async (
  env: Env,
  caller: VisitorCaller,
  request: unknown,
  deadline: number
): Promise<FunctionAnswer> => {
  const requestId = crypto.randomUUID();
  const refused = (error: unknown): FunctionAnswer => ({
    result: { ok: false, error: refusalOf(error, requestId) },
    provenance: null,
    manifestHash: null,
  });
  try {
    const call = callAllowed(request);
    const { name: contractId } = call.reference;
    // Who they are, and nothing of the directory (app-people.ts): no grant
    // opens it to a visitor.
    if (isPeoplePath(contractId)) {
      const read = peopleReadOf(call.reference);
      // Their session was found live, the App published and their address
      // listed before this call was taken: that is all telling them who
      // they are needs. Every directory read is refused, and recorded.
      return {
        result: {
          ok: true,
          value: await answerPeople(visitorPeopleOf(caller), read, call.args),
        },
        provenance: null,
        manifestHash: null,
      };
    }
    // Never granted, whatever the grants say: refused, and recorded, before
    // anything of the release is read.
    if (
      call.reference.kind === "action" ||
      isWorkflowQueryPath(contractId) ||
      isWorkflowMutationPath(contractId)
    ) {
      return refused(await caller.notGranted(contractId));
    }
    const release = await loadRelease(env, caller.app, caller.version);
    const { path } = referenceIn(release, call.reference);
    await caller.stillAllowed(path);
    await caller.admitted(path);
    const invocation = await visitorInvocation(
      env,
      release,
      caller,
      path,
      requestId,
      deadline
    );
    const result = await hostFunctionCall(
      hostedRelease(env, release),
      invocation,
      { path, kind: call.reference.kind },
      call.args,
      call.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: call.idempotencyKey }
    );
    return {
      result,
      provenance: null,
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
 * only if its reference names a public function of its kind there
 * (`publicFunctionOf`); then through the function host, which checks
 * its arguments with the function's own validator and decides the rest.
 * Never throws.
 */
export const callAppFunction = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams"> &
    Partial<Pick<Identity, "staff">>,
  app: unknown,
  request: unknown,
  deadline = Date.now() + platformLimits.serverInvocationWallMs,
  stillAllowed?: () => Promise<void>,
  /** The sandbox session (its call ID) of the Code Mode run that calls. */
  parentSession?: string,
  /** The agent whose call this is (`FunctionCaller.agent`). */
  agent?: CallingAgent
): Promise<FunctionAnswer> =>
  await callFunction(env, by, app, request, {
    deadline,
    ...(stillAllowed === undefined ? {} : { stillAllowed }),
    ...(parentSession === undefined ? {} : { parentSession }),
    ...(agent === undefined ? {} : { agent }),
  });

/**
 * The call `request` is, if it calls one of a workflow reference's
 * mutations (page-workflows.ts): core answers those itself, and only for
 * a page.
 */
const workflowMutationOf = (request: unknown): FunctionRequest | undefined => {
  try {
    const call = readFunctionRequest(request);
    return isWorkflowMutationPath(call.reference.name) ? call : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A page's call of a workflow reference's mutation (page-workflows.ts),
 * answered as a call is.
 */
const workflowMutationAnswer = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams"> &
    Partial<Pick<Identity, "staff">>,
  app: unknown,
  call: FunctionRequest
): Promise<FunctionAnswer> => {
  const requestId = crypto.randomUUID();
  try {
    const { value, manifestHash } = await answerWorkflowMutation(
      env,
      by,
      app,
      call
    );
    return {
      result: { ok: true, value },
      provenance: null,
      manifestHash,
    };
  } catch (error) {
    return {
      result: { ok: false, error: refusalOf(error, requestId) },
      provenance: null,
      manifestHash: null,
    };
  }
};

/**
 * Calls a public function of App `app` for a page of `by`'s, as
 * `callAppFunction` calls it, or one of a workflow reference's mutations,
 * which only a page calls. Never throws.
 */
export const callPageFunction = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams"> &
    Partial<Pick<Identity, "staff">>,
  app: unknown,
  request: unknown,
  deadline: number,
  options: Pick<FunctionCallOptions, "tellsForm"> = {}
): Promise<FunctionAnswer> => {
  const mutation = workflowMutationOf(request);
  return mutation === undefined
    ? await callFunction(env, by, app, request, {
        deadline,
        page: true,
        ...options,
      })
    : await workflowMutationAnswer(env, by, app, mutation);
};

/**
 * Whether `request` calls one of a workflow reference's queries
 * (workflow-reference-queries.ts): they read no store, so a live one is
 * read again when the person's runs of the App change, not on a write.
 */
export const callsWorkflowQuery = (request: unknown): boolean => {
  try {
    return isWorkflowQueryPath(readFunctionRequest(request).reference.name);
  } catch {
    return false;
  }
};

/**
 * Whether `request` calls a workflow reference's query a decision's
 * change may change for people other than its run's (its decision
 * queries, and `run`, which a reviewer reads only while one of its
 * decisions asks them): read again when a decision of one of the App's
 * runs changes, for whomever it asks (run-changes.ts,
 * `tellDecisionFollowers`).
 */
export const callsDecisionQuery = (request: unknown): boolean => {
  try {
    return isDecisionQueryPath(readFunctionRequest(request).reference.name);
  } catch {
    return false;
  }
};

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
  by: Pick<Identity, "userId" | "role" | "teams"> &
    Partial<Pick<Identity, "staff">>,
  app: unknown,
  request: string,
  deadline: number,
  /** What its subscription kept already (`FunctionCaller.refusalsKept`). */
  refusalsKept?: Set<string>
): Promise<EvaluatedQuery> => {
  let reads: EvaluatedQuery["reads"];
  const answer = await callFunction(env, by, app, request, {
    deadline,
    kind: "query",
    page: true,
    ...(refusalsKept === undefined ? {} : { refusalsKept }),
    observeReads: (storeId, readSet) => {
      reads = { storeId, readSet };
    },
  });
  return { answer, reads };
};

/**
 * Runs a public action of App `app` for `by` once, for the invocation
 * object that holds it (action-invocation.ts), as `callAppFunction` runs
 * any call: what it returned, or why it failed, and whether the function
 * host was reached at all (a refusal before it ran nothing of the App's). A streaming action
 * (spec 10.7.6) gets `progress`, where its snapshots go, and only one
 * does; `cancelled` stops either. It runs in `version`, the release the
 * invocation recorded, and only while that is still the App's current
 * one (`version.mismatch` otherwise): what runs is always what the record
 * names, so revoking that release stops its result being handed over.
 * Never throws.
 */
export const invokeAppAction = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams"> &
    Partial<Pick<Identity, "staff">>,
  app: string,
  call: FunctionRequest,
  {
    version,
    progress,
    cancelled,
    deadline,
  }: {
    /** The release the invocation recorded as the one it runs. */
    readonly version: number;
    readonly progress?: ProgressSink;
    readonly cancelled: AbortSignal;
    readonly deadline: number;
  }
): Promise<{
  readonly result: FunctionResult;
  /** Whether the function host was reached: App code may have run. */
  readonly reached: boolean;
  /** How many effects it made, or may have made (`CallOptions.onEffect`). */
  readonly effects: number;
  /**
   * The public action it ran, as the checked release it ran resolved it:
   * what a page's form sent as it names (action-invocation.ts).
   */
  readonly path?: string;
}> => {
  const requestId = crypto.randomUUID();
  let reached = false;
  let effects = 0;
  let resolved: string | undefined;
  try {
    const found = await usableApp(env, by, app);
    if (found.currentVersion === null) {
      throw versionErrors.create("version.not_sealed");
    }
    if (found.currentVersion !== version) {
      throw versionErrors.create("version.mismatch");
    }
    const release = await loadRelease(env, found.id, version);
    const path = publicFunctionOf(release, call.reference);
    resolved = path;
    const invocation = await invocationFor(env, release, {
      by,
      requestId,
      deadline,
    });
    reached = true;
    const result = await hostFunctionCall(
      hostedRelease(env, release),
      invocation,
      { path, kind: call.reference.kind },
      call.args,
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
    return { result, reached, effects, path };
  } catch (error) {
    return {
      result: { ok: false, error: refusalOf(error, requestId) },
      reached,
      effects,
      ...(resolved === undefined ? {} : { path: resolved }),
    };
  }
};
