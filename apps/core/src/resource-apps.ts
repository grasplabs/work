import { appCallLimits } from "@grasp-os/shared/apps";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import { executionErrors } from "@grasp-os/shared/workflows";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { findApp } from "./apps.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { memberRole, teamsOf } from "./auth/identity.ts";
import { appResourceBindings } from "./db/core/schema.ts";
import type {
  BindingCaller,
  DeclarationOf,
  RunOrigin,
  ResourceAdapter,
} from "./resource-adapter.ts";
import { isRestricted, restrict } from "./restricted.ts";
import { consumerFailure, declaredFingerprint } from "./store-operations.ts";

// An app resource (resource-bindings.ts): an App's binding of some of
// another App's public functions, which an admin approved for exactly the
// functions and contracts it declares. Threat model, and how each is
// closed:
//
// - A declaration self-grants: it resolves only through an active binding
//   an admin approved (resource-bindings.ts), to an App other than itself
//   whose current release serves every declared function public, of the
//   declared kind and with exactly the declared contract fingerprint;
//   checked as the admin approves and on every request. A contract or
//   visibility changed since stops it (`contract_changed`, `grant_lost`),
//   and the called release checks the fingerprint the call names again.
// - The wrong identity: every call runs the called function as a screen's
//   call of it runs (`callAppFunctionFrom`), for the person the calling
//   invocation acts for, their role and teams read here from core, never
//   anything App code sends. So the called App's own role check applies,
//   and what it writes is that person's; nothing of the calling App's
//   grants reaches it, nor anything of the called App's beyond its answer.
// - Calls going round, too deep or too many: every invocation carries the
//   Apps it was called through (`BindingCaller.chain`) and the whole
//   call's count of calls between Apps (`appCalls`). A call of an App
//   already in it is refused, and so is one past `appCallLimits.depth`
//   calls deep or past `appCallLimits.calls` in all, before anything is
//   sent; each call ends by the calling invocation's deadline.
// - A run starting workflows through another App: a call from a workflow
//   run's chain gives the called App's invocation no workflow starts, as
//   the run's own call has none (`fromRun`), and carries the run's lease to
//   its commits and requests.
// - An agent lost at the hop: the agent a call came from goes with it,
//   named on what the called App starts and on the call's record.
// - A revocation mid-call: before each of the called function's protected
//   steps, the calling invocation's own gate (its release, the person's
//   role, an agent's permission, a run's lease) and this binding, still
//   active (`stillAllowed`).
// - Data and restriction crossing unseen: restricted mode follows the data
//   both ways, each flag set before the data moves (restricted.ts); the
//   called function reads into the calling invocation's own sources, so
//   its model and connector requests meet the rules for everything the
//   chain read (an EU-only or sensitive connection's data included), and
//   a run's chain meets the run's budgets and rules (`runOrigin`).
// - Unseen: every call this binding serves is recorded before it runs
//   (`app.call`), as the caller's actor, with the called App, function and
//   version, and once more with why when the called App refuses it. The called App audits what it does as for any of its calls.

/** An app binding's contract: the App it binds, by its ID. */
const contractOf = (app: string): string => `app:${app}`;

/** Every function a declaration lists, as one App's current release serves it. */
interface ServedFunctions {
  readonly release: Release;
  readonly fingerprints: Readonly<Record<string, string>>;
}

/**
 * App `callee`'s current release; undefined when it has none, or there
 * is no such App.
 */
export const currentReleaseOf = async (
  env: Env,
  callee: AppId
): Promise<Release | undefined> => {
  try {
    const found = await findApp(env, callee);
    if (found.currentVersion === null) {
      return undefined;
    }
    return await loadRelease(env, found.id, found.currentVersion);
  } catch (error) {
    if (isExpectedError(error)) {
      return undefined;
    }
    throw error;
  }
};

/** The fingerprint of each function `declaration` lists, as declared. */
export const declaredFingerprints = async (
  declaration: DeclarationOf<"app">
): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(declaration.functions).map(
        async ([path, shape]) =>
          [path, await declaredFingerprint(shape)] as const
      )
    )
  );

/**
 * Each function `declared` names (`declaredFingerprints`), served by
 * `release` public, of the kind `declaration` declares and with exactly
 * the declared contract; undefined when any isn't.
 */
export const servedIn = (
  release: Release,
  declaration: DeclarationOf<"app">,
  declared: Readonly<Record<string, string>>
): ServedFunctions | undefined => {
  const fingerprints: Record<string, string> = {};
  for (const [path, shape] of Object.entries(declaration.functions)) {
    const operation = Object.hasOwn(release.app.operations, path)
      ? release.app.operations[path]
      : undefined;
    const served = release.fingerprints[path];
    if (
      operation?.visibility !== "public" ||
      operation.kind !== shape.kind ||
      served === undefined ||
      served !== declared[path]
    ) {
      return undefined;
    }
    fingerprints[path] = served;
  }
  return { release, fingerprints };
};

/**
 * Each function `declaration` lists, served by App `callee`'s current
 * release public, of the declared kind and with exactly the declared
 * contract; undefined when any isn't, or the App has no current release.
 */
const servedBy = async (
  env: Env,
  callee: AppId,
  declaration: DeclarationOf<"app">
): Promise<ServedFunctions | undefined> => {
  const release = await currentReleaseOf(env, callee);
  return release === undefined
    ? undefined
    : servedIn(release, declaration, await declaredFingerprints(declaration));
};

/**
 * Refuses a call of App `callee` from `caller` that would go round (an
 * App already in its chain), deeper than `appCallLimits.depth` calls (so
 * `depth` + 1 Apps, as an export call counts them), or past the whole
 * call's `appCallLimits.calls`, which it counts.
 */
const claimChainRoom = (caller: BindingCaller, callee: AppId): void => {
  const chain = caller.chain ?? [caller.app];
  if (chain.includes(callee)) {
    throw operationErrors.create("resource.limit_reached", { limit: "cycle" });
  }
  if (chain.length > appCallLimits.depth) {
    throw operationErrors.create("resource.limit_reached", { limit: "depth" });
  }
  const calls = caller.appCalls ?? { used: 0 };
  if (calls.used >= appCallLimits.calls) {
    throw operationErrors.create("resource.limit_reached", { limit: "calls" });
  }
  calls.used += 1;
};

/** A caller as the adapter needs it, with core's env. */
type Calling = BindingCaller & { readonly env: Env };

/** Who `caller` acts for, to the called App: as core knows them now. */
const personOf = async (caller: Calling) => {
  const userId = caller.authority.onBehalfOf;
  const role = await memberRole(caller.env.DB, userId);
  if (role === undefined) {
    throw operationErrors.create("resource.unavailable");
  }
  return { userId, role, teams: await teamsOf(caller.env.DB, userId) };
};

/**
 * The workflow run `caller`'s chain started from, if any: the run whose
 * budgets and rules a model request down the chain meets
 * (`BindingCaller.runOrigin`).
 */
const runOriginOf = (caller: BindingCaller): RunOrigin | undefined => {
  if (caller.runOrigin !== undefined) {
    return caller.runOrigin;
  }
  if (caller.context.type !== "run") {
    return undefined;
  }
  return {
    actor: caller.actor,
    ...(caller.shareSubject === undefined
      ? {}
      : { shareSubject: caller.shareSubject }),
  };
};

/** The `runOrigin` option for a call from `caller`, when its chain has one. */
const runOriginField = (caller: BindingCaller): { runOrigin?: RunOrigin } => {
  const runOrigin = runOriginOf(caller);
  return runOrigin === undefined ? {} : { runOrigin };
};

/** Calls `path` of `callee` with `args`, for `caller`, through binding `pin`. */
const callFor = async (
  caller: Calling,
  callee: AppId,
  served: ServedFunctions,
  request: { path: string; args: Json },
  context: {
    requestId: string;
    deadline: number;
    idempotencyKey: string;
    session?: string;
  },
  bindingId: string
): Promise<unknown> => {
  const { env } = caller;
  const { path, args } = request;
  const operation = served.release.app.operations[path];
  const fingerprint = served.fingerprints[path];
  if (operation === undefined || fingerprint === undefined) {
    throw operationErrors.create("resource.not_allowed");
  }
  // Only core's own invocations give one: without it, nothing is called,
  // marked or recorded.
  const { callApp } = caller;
  if (callApp === undefined) {
    throw operationErrors.create("resource.unavailable");
  }
  claimChainRoom(caller, callee);
  const by = await personOf(caller);
  const version = served.release.manifest.resourceVersion;
  // The called App, for the person, as restricted mode keeps it.
  const calleeAuthority: Authority = {
    subject: { type: "app", appId: callee },
    onBehalfOf: by.userId,
    mode: "interactive",
    appVersion: version,
  };
  const calleeContext: WorkContext = { type: "app", appId: callee };
  // Restricted mode follows the data both ways, each flag set before the
  // data moves: a restricted caller restricts the called App before its
  // arguments reach it, and a restricted called App restricts the caller
  // before its answer, or its refusal, reaches it.
  if (await isRestricted(env, caller.authority, caller.context)) {
    await restrict(env, calleeAuthority, calleeContext, [`app:${caller.app}`]);
  }
  const carryRestricted = async (): Promise<void> => {
    if (await isRestricted(env, calleeAuthority, calleeContext)) {
      await restrict(env, caller.authority, caller.context, [`app:${callee}`]);
    }
  };
  const detail = {
    function: path,
    version,
    binding: bindingId,
    onBehalfOf: by.userId,
    ...(caller.agent === undefined ? {} : { agent: caller.agent.agentId }),
  };
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: caller.actor,
    action: "app.call",
    target: { type: "app", id: callee },
    requestId: context.requestId,
    detail,
  });
  const answer = await callApp(
    by,
    callee,
    // As a screen sends it: text, bounded before it is read.
    JSON.stringify({
      reference: {
        resourceId: callee,
        resourceVersion: version,
        contractId: path,
        fingerprint,
        kind: operation.kind,
      },
      input: args,
      // A query takes no key; a mutation's or action's is the request's
      // own, so the same call made again answers from its receipt.
      ...(operation.kind === "query"
        ? {}
        : {
            idempotencyKey: `call:${await sha256Hex(context.idempotencyKey)}`,
          }),
    }),
    {
      deadline: context.deadline,
      ...(context.session === undefined
        ? {}
        : { parentSession: context.session }),
      chain: caller.chain ?? [caller.app],
      // A run's chain starts no workflows down it, and carries the run's
      // lease, which the called App's commits and requests check last.
      fromRun: caller.fromRun === true || caller.context.type === "run",
      ...(caller.agent === undefined ? {} : { agent: caller.agent }),
      appCalls: caller.appCalls ?? { used: 1 },
      // What the caller read is in what it passes on: the called function
      // reads into the caller's own sources, so its model and connector
      // requests are judged by everything the chain read (an EU-only or
      // sensitive connection's data included), and the caller's by what
      // it read in turn.
      sources: caller.sources,
      ...runOriginField(caller),
      ...(caller.requireHolds === undefined
        ? {}
        : { requireHolds: caller.requireHolds }),
      // Before each protected step of the called function: the calling
      // invocation's own gate, then this binding, still active. The
      // called App's own gate reads on after these; a run's lease is
      // checked at its commits and requests themselves (`requireHolds`).
      stillAllowed: async () => {
        await caller.admit?.();
        const row = await drizzle(env.DB)
          .select({ id: appResourceBindings.id })
          .from(appResourceBindings)
          .where(
            and(
              eq(appResourceBindings.id, bindingId),
              eq(appResourceBindings.appId, caller.app),
              eq(appResourceBindings.status, "active")
            )
          )
          .get();
        if (row === undefined) {
          throw operationErrors.create("resource.unavailable");
        }
      },
    }
  );
  await carryRestricted();
  if (!answer.result.ok) {
    // Refused by the called App or its host: recorded again, with why, so
    // the log tells a refused call from one that ran.
    await keepAuditEvent(env, drizzle(env.DB), {
      actor: caller.actor,
      action: "app.call",
      target: { type: "app", id: callee },
      requestId: context.requestId,
      detail: { ...detail, refused: answer.result.error.code },
    });
    // A run's step that let go of its lease meanwhile: as its own call
    // would be refused, never as the called App's answer.
    if (answer.result.error.code === "execution.stale_attempt") {
      throw executionErrors.create("execution.stale_attempt");
    }
    throw consumerFailure(answer.result.error);
  }
  return answer.result.value;
};

/** An app binding's target, served: its functions' calls, for each caller. */
const servedApp = async (env: Env, callee: AppId, served: ServedFunctions) => ({
  contractId: contractOf(callee),
  fingerprint: await sha256Hex(
    canonicalJson({ app: callee, functions: { ...served.fingerprints } })
  ),
  call: async (
    caller: BindingCaller,
    { args }: { method: string; args: readonly Json[] },
    context: {
      requestId: string;
      deadline: number;
      idempotencyKey: string;
      session?: string;
    },
    pin: { id: string }
  ): Promise<unknown> => {
    const [path, input] = args;
    if (typeof path !== "string" || input === undefined) {
      throw operationErrors.create("resource.not_allowed");
    }
    return await callFor(
      { ...caller, env },
      callee,
      served,
      { path, args: input },
      context,
      pin.id
    );
  },
});

export const appAdapter: ResourceAdapter<"app"> = {
  bind: async (env, app, declaration, target) => {
    const served =
      target.appId === app
        ? undefined
        : await servedBy(env, target.appId, declaration);
    return served === undefined
      ? undefined
      : await servedApp(env, target.appId, served);
  },
};
