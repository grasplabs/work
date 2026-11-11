import type { FunctionManifest } from "@grasp-os/runtime/host";
import { appErrors } from "@grasp-os/shared/apps";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { categoryOf } from "@grasp-os/shared/functions";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { stableIdPattern } from "@grasp-os/shared/store-limits";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";

import { callAppFunctionById, functionById } from "../app-functions.ts";
import { findApp, usableApp } from "../apps.ts";
import { memberOf } from "../auth/identity.ts";
import { appHost } from "../durable-objects.ts";
import { restrict } from "../restricted.ts";
import { requireAppCallAuthority } from "./resource-authority.ts";
import type { CallingRun, CandidateBinding } from "./resource-authority.ts";
import { boundedAnswer, requireShape } from "./resource-calls.ts";
import type { AppCall } from "./resource-calls.ts";

// A run of an independent workflow calling one of an App's functions
// (GRA-1663): `ctx.apps.<app>.<fn>(args)` in its code, a `grasp.app` call
// to its host (resource-calls.ts, `makeCall`), naming the App by its ID
// and the function by the stable ID the App's definition gives it.
//
// Threat model, and how each is closed:
//
// - A workflow calling a function it wasn't granted. Every call needs the
//   workflow's own active grant to `call` exactly that function of
//   exactly that App (`requireAppCallAuthority`), decided again as the
//   call is made and before every protected step of it, with the person
//   it acts for, the workflow and its start's invoker, so a revocation
//   stops a call already running. An App starts with no grant at all.
// - Reaching outside systems through the App. A workflow calls an App's
//   queries and mutations, never its actions: only an action reaches
//   connections, models, the Brain or guest chats (the SDK's
//   `isActionPermission`), and a workflow's own calls of those are
//   approved per version, as catalog bindings. A mutation may still
//   start the workflows the App holds a grant to start, or notify
//   people, as the App does for anyone using it: on the App's own
//   grants, which the data policy follows (data-policy.ts). A request or grant on an
//   action is refused (app-function-bindings.ts, `requireAppFunction`),
//   a publish turning a bound function into one is refused as a break,
//   and a call that resolves to one anyway is refused before it runs.
// - A later version of the workflow calling the function otherwise. The
//   grant is the approval: it names one query or mutation of one App,
//   for the `call` action, and is the workflow's, not one version's, so a
//   later version calling the same function needs no new review (allow
//   and audit). The function's validator, the App's row rules and role
//   access for the person each run acts for, restricted mode and the
//   receipts bound every call. A version that calls a function no active
//   grant names (its `apps` declaration naming one never granted, or
//   one revoked) is refused that call (`workflow.call_denied`) until an
//   admin grants it.
// - A later version of the App changing what the function does. The
//   grant trusts the code of the version an admin reviewed, as the App's
//   own write grants do, and is treated alike: a version made current by
//   someone who couldn't grant asks for it again (permissions.ts,
//   `madeCurrent`, the same statement), so the workflow's calls are
//   refused until an admin grants it over that version; one an admin
//   makes current keeps it. A publish also refuses a version whose
//   function no longer fits its callers (app-function-bindings.ts).
// - A forged ID, or one from another App or tenant. The grant names the
//   App and the function together, so an ID granted on one App reaches
//   nothing on another, and an ID nobody granted reaches nothing; an ID
//   that isn't one at all is refused before anything is read. A
//   deployment is one client's: another tenant's IDs are in another
//   database, so none is ever granted here.
// - A stale ID: a function removed, or an App with no current version.
//   The ID is resolved as the call is made, in the release of the App's
//   current version and through the definition it was sealed with
//   (app-functions.ts, `callAppFunctionById`), never by a name the
//   workflow holds: what nothing serves fails the call clearly
//   (`workflow.app_function_unavailable`), and a publish that would
//   leave a bound function so is refused (app-function-bindings.ts).
// - A rename swapping meaning. A rename keeps the ID
//   (`renameFunction`), so the run reaches the function it was bound to
//   under its new name; a function added at the old path has a new ID,
//   which no grant names: each query and mutation gets its ID as a
//   commit brings it; one gone loses its ID, which comes back only to
//   its own path, from the current version, never to another's
//   (apps.ts, `storedVersion`). A commit refuses an ID put on another
//   function's path, and a publish an ID moved there, or one that no
//   longer fits its callers (app-function-bindings.ts).
// - `__proto__` and its kin. A function ID is a stable ID (letters,
//   digits and `:._-`, starting with a letter or digit), so none is
//   `__proto__`; a function's path is resolved through a Map and
//   `Object.hasOwn`, never a plain object's lookup.
// - Replay. A replay never calls: the step answers what it recorded
//   (sealed-run.ts). A retry calls again under the same effect key, which
//   keys a mutation's receipt (`idempotencyKey`), scoped by the function's
//   ID rather than its path (`receiptScope`), so a mutation commits once
//   and its retry answers the stored outcome, a rename in between too. A
//   query only reads.
// - Data crossing either way. The call runs as the person the run acts
//   for, under the App's own row rules and role access: they need a role
//   in the App, checked before anything else of the App is touched. A
//   restricted run's mutation restricts the App once the function is
//   resolved, just before its arguments reach it, never for a call
//   refused before, nor a query, which keeps nothing of them; an
//   App in restricted mode answers an unrestricted run nothing, checked
//   before and after the call (restricted.ts). What the App's data
//   reaches through the workflow, and the workflow's through the App, the
//   data policy follows (data-policy.ts).
// - Evidence. Its receipts, kept by `makeCall` before and after, name
//   the run, workflow, App, function ID, key, person and outcome, and the
//   call's request ID, never an argument or an answer. The App's own
//   evidence of the call (its sensitive reads, a use it refused) names
//   the person the run acts for, as a run's calls are that person's, and
//   the same request ID, so each is found from the run that made it.

/** What `callApp` needs of the call's effect (resource-calls.ts, `Effect`). */
interface AppCallEffect {
  readonly key: string;
  readonly deadline: number;
  readonly requireHolds: () => void;
}

/** The refusal of a call that resolves to an App's action. */
const actionRefused = () =>
  workflowResourceErrors.create("workflow.call_invalid", {
    issues: [
      "A workflow calls an App's queries and mutations, never its actions.",
    ],
  });

/**
 * The refusals of a call core made before any function ran that say the
 * function isn't there to call: no such App for the person, no current
 * version, no function by that ID.
 */
const unavailableCodes: ReadonlySet<string> = new Set([
  "app.not_found",
  "version.not_sealed",
  "function.not_found",
]);

/** Refuses an App call from an unrestricted run while the App is restricted. */
const requireNotRestricted = async (
  env: Env,
  run: CallingRun,
  app: AppId
): Promise<void> => {
  if (!run.restricted && (await appHost(env, app).isRestricted())) {
    throw permissionErrors.create("permission.restricted");
  }
};

/**
 * Restricts App `app` for good before a restricted run's arguments reach
 * it: they may carry what the run read restricted.
 */
const carryRestricted = async (
  env: Env,
  run: CallingRun,
  app: AppId
): Promise<void> => {
  const { currentVersion } = await findApp(env, app);
  await restrict(
    env,
    {
      subject: { type: "app", appId: app },
      onBehalfOf: run.principal,
      mode: "workflow",
      appVersion: currentVersion ?? undefined,
    },
    { type: "app", appId: app },
    [`workflowRun:${run.runId}`]
  );
};

/**
 * Makes `call` of `run`, as the effect `effect`: see the header. Answers
 * the function's value as JSON, or throws `workflow.call_denied`,
 * `workflow.app_function_unavailable`, `permission.restricted` or
 * `workflow.app_call_failed` (naming the App's error code).
 */
export const callApp = async (
  env: Env,
  run: CallingRun,
  call: AppCall,
  effect: AppCallEffect,
  /** Told the request ID the App's own evidence of the call names. */
  requested: (requestId: string) => void
): Promise<unknown> => {
  const app = appIdSchema.safeParse(call.app);
  if (
    !app.success ||
    typeof call.function !== "string" ||
    !stableIdPattern.test(call.function)
  ) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const appId = app.data;
  // What the host refused the call with itself, as the call ran (its
  // attempt gone, its authority lost, restricted data, an action): thrown
  // as it is, never as the App's answer, so the run's step decides it as
  // the host's own (resource-errors.ts).
  let refusedBy: Error | undefined;
  const own =
    <Args extends unknown[]>(check: (...args: Args) => Promise<void>) =>
    async (...args: Args): Promise<void> => {
      try {
        await check(...args);
      } catch (error) {
        refusedBy ??= error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    };
  const authorized = own(async (): Promise<void> => {
    effect.requireHolds();
    await requireAppCallAuthority(env, run, appId, call.function);
  });
  await authorized();
  const person = await memberOf(env.DB, run.principal);
  if (person === undefined) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  // Only someone with a role in the App reaches it at all: a restricted
  // run can't restrict an App its person can't use.
  try {
    await usableApp(env, person, appId);
  } catch (error) {
    if (appErrors.codeOf(error) === "app.not_found") {
      throw workflowResourceErrors.create("workflow.app_function_unavailable");
    }
    throw error;
  }
  await requireNotRestricted(env, run, appId);
  const answer = await callAppFunctionById(
    env,
    person,
    appId,
    {
      id: call.function,
      input: call.arguments,
      // The step's key, the same in every attempt, as a receipt's key.
      idempotencyKey: `workflow:${await sha256Hex(effect.key)}`,
    },
    {
      deadline: effect.deadline,
      stillAllowed: authorized,
      // Once the function is resolved, right before it runs: nothing of
      // the App is restricted for a call that never reaches it.
      running: own(async (kind: FunctionManifest["kind"]) => {
        effect.requireHolds();
        if (kind === "action") {
          throw actionRefused();
        }
        // A mutation may keep what it is sent; a query keeps nothing.
        if (run.restricted && kind === "mutation") {
          await carryRestricted(env, run, appId);
        }
        await requireNotRestricted(env, run, appId);
        effect.requireHolds();
      }),
    }
  );
  requested(answer.requestId);
  if (refusedBy !== undefined) {
    throw refusedBy;
  }
  // What it answers may hold what the App read restricted meanwhile.
  await requireNotRestricted(env, run, appId);
  const { result } = answer;
  if (result.ok) {
    return result.value;
  }
  const { error } = result;
  if (answer.manifestHash === null && unavailableCodes.has(error.code)) {
    throw workflowResourceErrors.create("workflow.app_function_unavailable");
  }
  // An outcome unknown (it may have committed), or a failure a retry may
  // clear: kept as the App's call answered it, so the run's step neither
  // takes the first as a failure a catch may handle nor loses the second's
  // retry (resource-errors.ts).
  if (categoryOf(error.code) === "uncertain" || error.retryable) {
    throw Object.assign(new Error(error.message), {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  throw workflowResourceErrors.create("workflow.app_call_failed", {
    code: error.code,
  });
};

/**
 * The key a test run's start answers `call` under (candidate-runs.ts):
 * its App's ID and its function's, as an App call goes through no
 * binding.
 */
export const appCallKey = ({
  app,
  function: fn,
}: Pick<AppCall, "app" | "function">): string => `app:${app}/${fn}`;

/**
 * What `call` of a test run of a draft's checkpoint answers: the answer
 * its start gave under `appCallKey` (`binding`, of kind `app`), checked
 * against what the function answers in the App's current version, as a
 * real call's would be. Nothing is called: only the App's release is
 * read, for a person with a role in the App.
 */
export const candidateAppAnswer = async (
  env: Env,
  run: CallingRun,
  binding: CandidateBinding | undefined,
  call: AppCall
): Promise<Json> => {
  if (binding?.kind !== "app" || binding.answer === undefined) {
    throw workflowResourceErrors.create("workflow.candidate_unfixtured");
  }
  const app = appIdSchema.safeParse(call.app);
  const person = await memberOf(env.DB, run.principal);
  if (!app.success || person === undefined) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  let fn: FunctionManifest;
  try {
    ({ fn } = await functionById(env, person, app.data, call.function));
  } catch (error) {
    const code = isExpectedError(error) ? error.code : undefined;
    if (code !== undefined && unavailableCodes.has(code)) {
      throw workflowResourceErrors.create("workflow.app_function_unavailable");
    }
    throw error;
  }
  if (fn.kind === "action") {
    throw actionRefused();
  }
  return fn.returns === null
    ? boundedAnswer(binding.answer, "output")
    : requireShape(JSON.stringify(fn.returns), binding.answer, "output");
};
