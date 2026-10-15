import { actorOf } from "@grasp-os/shared/audit";
import {
  authErrors,
  internalErrors,
  isExpectedError,
  requestErrors,
} from "@grasp-os/shared/errors";
import type { CodedError } from "@grasp-os/shared/errors";
import { readAtMost, requestIdHeader } from "@grasp-os/shared/http";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { LogFields } from "@grasp-os/shared/log";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { operationErrors } from "@grasp-os/shared/operations";
import type { AppErrorPayload } from "@grasp-os/shared/operations";
import { portableFunctionPath } from "@grasp-os/shared/portable";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  appFunctionPath,
  jsonBytes,
  screenErrors,
  screenLeaseHeader,
  screenLimits,
  screenPersonHeader,
  streamCallActions,
} from "@grasp-os/shared/screens";
import type { StreamCallAction } from "@grasp-os/shared/screens";
import { idempotencyKeySchema } from "@grasp-os/shared/submissions";

import {
  accessOf,
  actionInvocation,
  invocationName,
} from "./action-invocation.ts";
import {
  callAppFunction,
  readFunctionRequest,
  refusalOf,
} from "./app-functions.ts";
import type { FunctionAnswer, FunctionRequest } from "./app-functions.ts";
import { checkAppToken } from "./auth/app-tokens.ts";
import type { TokenCheck } from "./auth/app-tokens.ts";
import { identify } from "./auth/identity.ts";
import { appHost } from "./durable-objects.ts";
import { errorResponse } from "./errors.ts";
import { requireNotRevoked } from "./release-runner.ts";
import { isOwnOrigin } from "./rpc.ts";
import { delivering, leasedArtifact, requireDelivery } from "./screen-trust.ts";
import { admitted } from "./screens-rpc.ts";

// A running App's screen calling one of its App's functions (spec 32.6):
// `POST /api/app-functions/<app>`, the request as the body, the frame's
// lease in a header. A plain request, not the page's WebSocket, so the
// request's bytes are bounded as they are read, before anything parses
// them: one message on the socket may be 14 MiB. Threat model, and how
// each is closed:
//
// - A request too large to bother with: the body is read no further than
//   `functionRequestMaxBytes`, whatever `content-length` says, and the
//   request is refused before it is decoded or parsed.
// - Another site calls in the person's name: only from the deployment's
//   own pages (`Origin`) and only with a JSON body, which no form on
//   another site can send without a preflight core never answers.
// - Someone without a role in the App, or who lost it: the session is read
//   on every request, the role checked by the call itself
//   (`callAppFunction`), and the App named only by the path.
// - The page's frame was opened for one person and the browser's cookie
//   is now someone else's (they signed in in another tab): the page names
//   the person its frame is for (`screenPersonHeader`), and a call whose
//   session is anyone else's is refused (`auth.principal_changed`) before
//   it is counted or read, so what the frame sends again, such as a save
//   under an idempotency key whose answer was lost, never runs as them.
//   A call that names nobody comes from a page older than the header (a
//   tab left open across a deploy): refused alike, as out of date
//   (`screen.reload_required`), not as someone else signing in.
//   A lease is signed for one person too, but a screen of ordinary data
//   runs without a valid one, so the lease alone doesn't hold this.
// - Code nobody approved gets the App's data: the frame's lease, signed
//   by core for exactly this person and App, says which build calls; the
//   call runs only inside `delivering`, which checks that build's trust
//   before the call and again before its answer. No lease is unreviewed.
// - A flood: each request counts against the person's requests of the
//   App's screens (`admitted`), before its body is read.
// - An answer larger than a frame takes: refused here
//   (`screen.answer_too_large`), as a call of the App's server is.
//
// A portable host (spec 10.7.1: the App's UI outside Grasp's shell, a
// native app or another site) calls the same functions at
// `POST /api/portable/app-functions/<app>` with an App token
// (auth/app-tokens.ts) as `Authorization: Bearer`, under the same bounds.
// What differs, and why:
//
// - Who calls: the token alone, never a cookie. Cookies are not read on
//   that route, and the cookie route reads no token, so neither can lend
//   its authority to the other.
// - From where: any origin. The token is the authority and a browser
//   attaches it to nothing by itself, so a site that has none gets
//   nothing; CORS answers without credentials, so a browser never sends
//   the person's cookies along. The cookie route still answers no
//   preflight.
// - Which code gets the data: no build core approved, since core doesn't
//   deliver the host's code. It runs as a screen without a lease does:
//   only when an admin classified the App's data `ordinary` (accepting
//   that it goes to code nobody approved), never once the release of the
//   App's current version is revoked; checked before the call and again
//   before its answer, and a refusal recorded (screen-trust.ts).
// - The budget: the same as the person's screens of that App, so a token
//   adds no requests to it.
//
// A streaming action (spec 10.7.6) goes through the same admission, at
// `<path>/<app>/<stream | attach | cancel>`, and runs in an object of its
// own (action-invocation.ts), which keeps its latest progress and its
// receipt. Its frames outlive the request that started them, so:
// - Progress reaches someone who lost access, or code that lost its
//   approval: the relay checks again, at most every `streamRecheckMs`
//   before progress and always before the result, that the session is
//   still the person's, their role in the App and the build's delivery;
//   checked on a timer, frames or not, so a silent action is checked too;
//   a refusal ends the relay with it and cancels the invocation at once.
// - Access narrowed since the stream started reaches what it computed:
//   the relay refuses once the person's role or teams differ from those
//   it started under (`operation.access_changed`), and so does the
//   invocation on an attach or a join.
// - Another person reaches the stream: the invocation is named by the
//   person signed in, never by anything in the request.
//
// A plain action sent under a key (`<path>/<app>`, as every session
// client sends one) runs in the same object, without progress
// (`streaming: false`), so a lost answer is recovered by its key: the
// resend joins the run under way or answers its receipt, never runs it
// again. Every resend is admitted exactly as a start is, the person's
// access fingerprinted again (`accessOf`), the build's delivery checked
// before the run and again before its answer. A portable host's action
// goes the same way, its token checked again where a screen's session is.

/** How long a screen waits for a function's answer. */
const screenCallMs = 30_000;

/** The App ID after `base` in `pathname`, if it is one of base's paths. */
export const appAfter = (
  pathname: string,
  base: string
): string | undefined => {
  const prefix = `${base}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const app = pathname.slice(prefix.length);
  return app.length > 0 && !app.includes("/") ? app : undefined;
};

/** The App ID in `pathname`, if it is a function call's path. */
export const functionCallApp = (pathname: string): string | undefined =>
  appAfter(pathname, appFunctionPath);

/** The App ID in `pathname`, if it is a portable host's call's path. */
export const portableCallApp = (pathname: string): string | undefined =>
  appAfter(pathname, portableFunctionPath);

const streamActions: ReadonlySet<string> = new Set(streamCallActions);

const isStreamAction = (value: string): value is StreamCallAction =>
  streamActions.has(value);

/** The App ID and what to do, if `pathname` is a streaming action's call. */
const functionStreamCall = (
  pathname: string
): { app: string; action: StreamCallAction } | undefined => {
  const prefix = `${appFunctionPath}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const [app, action, ...rest] = pathname.slice(prefix.length).split("/");
  if (
    app === undefined ||
    app.length === 0 ||
    action === undefined ||
    rest.length > 0 ||
    !isStreamAction(action)
  ) {
    return undefined;
  }
  return { app, action };
};

/** The status a refusal before the call answers with. */
export const statusOf = (code: string): number => {
  if (code === "screen.rate_limited") {
    return 429;
  }
  if (code.startsWith("auth.")) {
    return 401;
  }
  return 403;
};

/** `answer`, unless it is more than a frame takes in one call. */
const withinFrame = (answer: FunctionAnswer): FunctionAnswer => {
  if (jsonBytes(answer, screenLimits.answerBytes) > screenLimits.answerBytes) {
    throw screenErrors.create("screen.answer_too_large");
  }
  return answer;
};

/** Whether `request` says its body is JSON. */
export const isJson = (request: Request): boolean =>
  request.headers.get("content-type")?.split(";")[0]?.trim() ===
  "application/json";

/**
 * A refusal as its error response, or an unexpected failure, logged as
 * `event`, as `internal.unexpected`.
 */
export const refusalResponse = (
  error: unknown,
  requestId: string,
  event: string
): Response => {
  if (isExpectedError(error)) {
    return errorResponse(statusOf(error.code), error, requestId);
  }
  log.error(event, { requestId, ...errorFields(error) });
  return errorResponse(
    500,
    internalErrors.create("internal.unexpected"),
    requestId
  );
};

/** How much of a path's App ID a log line keeps: the path is the caller's. */
const loggedAppMaxLength = 128;

/** How long a window of refused-token log lines is. */
const tokenLogWindowMs = 60_000;

/** How many refused-token lines one isolate writes a window, at most. */
const tokenLogsPerWindow = 20;

/** The window being counted, its lines so far, and the lines left out. */
const tokenLog = { window: 0, written: 0, dropped: 0 };

/**
 * Logs a genuine App token refused (for another App, a session that
 * ended, a person without access): at most `tokenLogsPerWindow` lines a
 * minute per isolate, the rest counted in one line when the next window
 * starts, so someone holding a token can't flood the logs with it.
 */
const logRefusedToken = (fields: LogFields): void => {
  const window = Math.floor(Date.now() / tokenLogWindowMs);
  if (window !== tokenLog.window) {
    if (tokenLog.dropped > 0) {
      log.warn("portable.token_refused.dropped", { count: tokenLog.dropped });
    }
    Object.assign(tokenLog, { window, written: 0, dropped: 0 });
  }
  if (tokenLog.written >= tokenLogsPerWindow) {
    tokenLog.dropped += 1;
    return;
  }
  tokenLog.written += 1;
  log.warn("portable.token_refused", fields);
};

/**
 * Records that `person` called `app` from a portable host, with the
 * session its token came from: once a window per person, session and App
 * (the App host's `auditOnce`), not a row a call.
 */
const recordPortableUse = async (
  env: Env,
  person: Identity,
  app: AppId,
  session: string
): Promise<void> => {
  await appHost(env, app).auditOnce(
    canonicalJson(["portable", person.userId, session]),
    {
      actor: actorOf(person),
      action: "app.portable.called",
      target: { type: "app", id: app },
      detail: { session },
    }
  );
};

/** Who calls, and as which build (`undefined`: none core approved). */
interface Caller {
  person: Identity;
  /** The lease the call came with, or `undefined` for none. */
  lease: string | null | undefined;
  /** The gate's name for what is asked, in a refusal's record. */
  operation: string;
  /** For a portable host's call: the session its App token came from. */
  portableSession?: string;
  /** Who calls now, read again: the session, or the App token, still theirs. */
  current: () => Promise<Identity | undefined>;
}

/** One frame's line as the relay reads it: its type, if it is JSON at all. */
const frameOf = (line: string): { type?: unknown; result?: unknown } => {
  try {
    const frame: unknown = JSON.parse(line);
    return typeof frame === "object" && frame !== null ? frame : {};
  } catch {
    return {};
  }
};

/** The call and its key, if `body` is an action sent under a valid key. */
const keyedAction = (
  body: string
): { call: FunctionRequest; key: string } | undefined => {
  let call: FunctionRequest;
  try {
    call = readFunctionRequest(body);
  } catch {
    // The call refuses it, as it refuses any request it can't read.
    return undefined;
  }
  const key = idempotencyKeySchema.safeParse(call.idempotencyKey);
  return call.reference.kind === "action" && key.success
    ? { call, key: key.data }
    : undefined;
};

/** Which App a keyed action is for, and as which build. */
interface KeyedTarget {
  readonly id: AppId;
  readonly artifact: string | undefined;
}

/**
 * The release versions an invocation's answer comes from: the caller's,
 * and the one it runs, or ran, under (`ActionInvocation.version`), which a
 * join, an attach or a receipt may have from before a publish.
 */
const releasesOf = async (
  invocation: ReturnType<typeof actionInvocation>,
  userId: string,
  call: FunctionRequest
): Promise<readonly number[]> => {
  const running = await invocation.version(userId);
  return [
    ...new Set([
      call.reference.resourceVersion,
      ...(running === undefined ? [] : [running]),
    ]),
  ];
};

/**
 * Throws `version.revoked` once any of `versions` of `app` is revoked:
 * the build's delivery reads the App's current release only, which a
 * publish moves on from the one an invocation ran.
 */
const requireReleasesLive = async (
  env: Env,
  app: AppId,
  versions: readonly number[]
): Promise<void> => {
  for (const version of versions) {
    // oxlint-disable-next-line no-await-in-loop -- one or two, in turn
    await requireNotRevoked(env, app, version);
  }
};

/**
 * Whether `caller` is still who they were, with the access `access`
 * fingerprints, and their build still gets the App's data: throws the
 * refusal otherwise.
 */
const stillTheirs = async (
  env: Env,
  { person, operation, current }: Caller,
  { id, artifact }: KeyedTarget,
  { access, versions }: { access: string; versions: readonly number[] }
): Promise<void> => {
  const now = await current();
  if (now?.userId !== person.userId) {
    throw authErrors.create("auth.unauthenticated");
  }
  // Refuses, too, someone with no role in the App any more.
  if ((await accessOf(env, now, id)) !== access) {
    throw operationErrors.create("operation.access_changed");
  }
  await requireDelivery(env, now, id, artifact, {
    operation,
    stage: "delivery",
  });
  await requireReleasesLive(env, id, versions);
};

/**
 * `refusal`, of an action's answer after it ran, as the outcome it
 * withholds: `submission.outcome_unknown`, uncertain, with the key that
 * recovers it once the person may have it again and the refusal's code.
 */
const withheld = (
  refusal: { readonly code: string },
  key: string
): AppErrorPayload => ({
  code: "submission.outcome_unknown",
  message:
    "Whether this finished is unknown: its answer was withheld. Sending it again with the same idempotency key gets its outcome, and never runs it a second time.",
  category: "uncertain",
  retryable: false,
  requestId: crypto.randomUUID(),
  details: { idempotencyKey: key, refusal: refusal.code },
});

/** What a keyed action answers: what it ran, as far as its invocation keeps. */
interface KeyedAnswer {
  readonly result: unknown;
  readonly provenance: null;
  readonly fingerprint: string;
  readonly manifestHash: null;
}

/**
 * The answer to the plain action `call`, under `key`, for `caller`: from
 * the invocation its key names (action-invocation.ts), which starts it,
 * joins it or answers its receipt, read to its result. Its result comes
 * from core's own object, so it is handed on as it is; what it read (its
 * provenance) stays with the run, and so does the release it ran
 * (`manifestHash`), which the receipt doesn't keep.
 *
 * What the invocations keep now grows with every keyed action, not just
 * with streams: accepted, since the invocation object's cap on running
 * plain actions, the request rate, and its receipt's retention and
 * tombstone bound how many one person holds in an App, and no answer is
 * larger than an operation's.
 */
const keyedAnswer = async (
  env: Env,
  caller: Caller,
  target: KeyedTarget,
  { call, key }: { call: FunctionRequest; key: string }
): Promise<KeyedAnswer> => {
  const { person, operation } = caller;
  const { id, artifact } = target;
  // Nothing ran yet: a build nobody approved is refused as any call is.
  await requireDelivery(env, person, id, artifact, {
    operation,
    stage: "admission",
  });
  const name = await invocationName(person.userId, id, call, key, false);
  const access = await accessOf(env, person, id);
  const invocation = actionInvocation(env, name);
  const frames = await invocation.open({
    by: { userId: person.userId, role: person.role, teams: person.teams },
    access,
    app: id,
    name,
    call,
    streaming: false,
    attach: false,
  });
  const text = await new Response(frames).text();
  const frame = text
    .split("\n")
    .map((line) => frameOf(line))
    .find(({ type }) => type === "result");
  if (frame === undefined) {
    throw new Error("The invocation ended without a result.");
  }
  const versions = await releasesOf(invocation, person.userId, call);
  const answer: KeyedAnswer = {
    result: frame.result,
    provenance: null,
    fingerprint: call.reference.fingerprint,
    manifestHash: null,
  };
  // Checked again before the answer is handed over, as a stream's relay
  // checks before its result: someone signed out, whose access changed,
  // whose build lost its approval, or whose answer's release was revoked
  // while it ran gets nothing of it. The
  // run settles on its own receipt whatever happens here, and may have
  // changed something: the refusal is no answer to what it did, so it
  // goes back as an outcome withheld, with its key, never as a failure
  // that invites a resubmit under a fresh one.
  try {
    await stillTheirs(env, caller, target, { access, versions });
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    return { ...answer, result: { ok: false, error: withheld(error, key) } };
  }
  if (jsonBytes(answer, screenLimits.answerBytes) <= screenLimits.answerBytes) {
    return answer;
  }
  // The action ran, and its receipt holds an answer larger than a screen
  // takes: what it did is unknown to the screen, not refused.
  const refusal = refusalOf(
    screenErrors.create("screen.answer_too_large"),
    crypto.randomUUID()
  );
  return {
    ...answer,
    result: {
      ok: false,
      error: {
        ...refusal,
        category: "uncertain",
        details: { idempotencyKey: key },
      },
    },
  };
};

/**
 * Calls a function of `app` for `caller` under the bounds of the header:
 * counted, the body read no further than a request may be, the build's
 * trust checked before and after. Answers the call's `FunctionAnswer`,
 * whatever its result; a refusal before the call as an error response.
 */
const boundedCall = async (
  request: Request,
  env: Env,
  app: string,
  caller: Caller,
  requestId: string
): Promise<Response> => {
  const { person, lease, operation, portableSession } = caller;
  try {
    const id = await admitted(env, person, app);
    // SAFETY: a request's body in workerd is a byte stream, of Uint8Array
    // chunks; its type says `any` only for streams in general.
    const stream = request.body as ReadableStream<Uint8Array> | null;
    const length = Number(request.headers.get("content-length") ?? 0);
    const body =
      stream === null || length > functionRequestMaxBytes
        ? undefined
        : await readAtMost(stream, functionRequestMaxBytes);
    if (body === undefined) {
      return errorResponse(
        413,
        requestErrors.create("request.too_large"),
        requestId
      );
    }
    // Recorded once the call is one it reads: a body past the bound costs
    // the audit log nothing.
    if (portableSession !== undefined) {
      await recordPortableUse(env, person, id, portableSession);
    }
    const artifact =
      lease === undefined
        ? undefined
        : await leasedArtifact(env, person.userId, id, lease);
    const text = new TextDecoder().decode(body);
    const keyed = keyedAction(text);
    if (keyed !== undefined) {
      // Checks delivery itself, before the run and again before its answer.
      return Response.json(
        await keyedAnswer(env, caller, { id, artifact }, keyed)
      );
    }
    const answer = await delivering(
      env,
      person,
      id,
      artifact,
      operation,
      async () =>
        withinFrame(
          await callAppFunction(
            env,
            person,
            id,
            text,
            Date.now() + screenCallMs
          )
        )
    );
    return Response.json(answer);
  } catch (error) {
    return refusalResponse(error, requestId, "app_function.failed");
  }
};

/**
 * The refusal of a screen's call whose frame names someone other than
 * the person signed in (`screenPersonHeader`, see the header), or none:
 * a streaming action's calls as much as a plain call.
 */
const personRefusal = (
  request: Request,
  person: Identity,
  app: string,
  requestId: string
): Response | undefined => {
  const named = request.headers.get(screenPersonHeader);
  if (named === person.userId) {
    return undefined;
  }
  const refusal =
    named === null
      ? screenErrors.create("screen.reload_required")
      : authErrors.create("auth.principal_changed");
  // Who was named and who is signed in stay out of the log: only why,
  // and for which App.
  log.info("app_function.person_refused", {
    requestId,
    app: app.slice(0, loggedAppMaxLength),
    reason: refusal.code,
  });
  return errorResponse(statusOf(refusal.code), refusal, requestId);
};

/**
 * `POST /api/app-functions/<app>`: calls a function of the App for the
 * person signed in, as their screen running the build its lease names
 * (see the header). Answers the call's `FunctionAnswer`, whatever its
 * result; a refusal before the call as an error response.
 */
export const appFunctionResponse = async (
  request: Request,
  env: Env,
  app: string,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  if (!(isOwnOrigin(request, env) && isJson(request))) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const person = await identify(env, request.headers);
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  const misnamed = personRefusal(request, person, app, requestId);
  if (misnamed !== undefined) {
    return misnamed;
  }
  return await boundedCall(
    request,
    env,
    app,
    {
      person,
      // A missing lease is no build: unreviewed.
      lease: request.headers.get(screenLeaseHeader),
      operation: "call",
      current: async () => await identify(env, request.headers),
    },
    requestId
  );
};

/** How long a browser may keep a preflight's answer: 10 minutes. */
const preflightMaxAgeSeconds = 600;

/**
 * CORS for a portable host on any origin, without credentials: the
 * browser sends no cookies, and the page reads the answer and its
 * request ID.
 */
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": requestIdHeader,
} as const;

/** `response`, readable by a portable host on any origin. */
const withCors = (response: Response): Response => {
  const readable = new Response(response.body, response);
  for (const [name, value] of Object.entries(corsHeaders)) {
    readable.headers.set(name, value);
  }
  return readable;
};

/** `Authorization: Bearer <token>`'s token, if the request has one. */
const bearerToken = (request: Request): string | undefined => {
  const [scheme, token, ...more] = (
    request.headers.get("authorization") ?? ""
  ).split(" ");
  return scheme?.toLowerCase() === "bearer" &&
    token !== undefined &&
    token.length > 0 &&
    more.length === 0
    ? token
    : undefined;
};

/** A refusal before anything is read, for a portable host to read. */
const refused = (
  status: number,
  error: CodedError,
  requestId: string
): Response => withCors(errorResponse(status, error, requestId));

/**
 * `/api/portable/app-functions/<app>`: a portable host's preflight, or
 * its call of a function of the App for the person its App token names
 * (see the header).
 */
export const portableFunctionResponse = async (
  request: Request,
  env: Env,
  app: string,
  requestId: string
): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": String(preflightMaxAgeSeconds),
      },
    });
  }
  if (request.method !== "POST") {
    return refused(404, requestErrors.create("request.not_found"), requestId);
  }
  if (!isJson(request)) {
    return refused(403, requestErrors.create("request.forbidden"), requestId);
  }
  const token = bearerToken(request);
  let checked: TokenCheck;
  try {
    checked =
      token === undefined
        ? { ok: false, reason: "invalid" }
        : await checkAppToken(env, token, app);
  } catch (error) {
    return withCors(
      refusalResponse(error, requestId, "app_token.check_failed")
    );
  }
  if (!checked.ok && checked.reason === "keys_pending") {
    return refused(503, authErrors.create("auth.token_unavailable"), requestId);
  }
  if (!checked.ok) {
    if (checked.reason !== "invalid") {
      logRefusedToken({
        requestId,
        app: app.slice(0, loggedAppMaxLength),
        reason: checked.reason,
        userId: checked.userId,
        sessionId: checked.sessionId,
      });
    }
    return refused(401, authErrors.create("auth.unauthenticated"), requestId);
  }
  return withCors(
    await boundedCall(
      request,
      env,
      app,
      {
        person: checked.person,
        lease: undefined,
        operation: "portable.call",
        portableSession: checked.sessionId,
        current: async () => {
          const now = await checkAppToken(env, token ?? "", app);
          return now.ok ? now.person : undefined;
        },
      },
      requestId
    )
  );
};

/** A call core admitted: who makes it, for which App, its body, its build. */
interface AdmittedCall {
  readonly person: Identity;
  readonly id: AppId;
  readonly body: string;
  readonly artifact: string | undefined;
}

/**
 * What every call of a screen's passes before anything reads its body
 * (see the header): the method, the origin, JSON, a session, the
 * person's rate, the body bounded and the lease read. A refusal as the
 * response to answer.
 */
const admitCall = async (
  request: Request,
  env: Env,
  app: string,
  requestId: string
): Promise<AdmittedCall | Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  if (!(isOwnOrigin(request, env) && isJson(request))) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const person = await identify(env, request.headers);
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  const misnamed = personRefusal(request, person, app, requestId);
  if (misnamed !== undefined) {
    return misnamed;
  }
  const id = await admitted(env, person, app);
  // SAFETY: a request's body in workerd is a byte stream, of Uint8Array
  // chunks; its type says `any` only for streams in general.
  const stream = request.body as ReadableStream<Uint8Array> | null;
  const length = Number(request.headers.get("content-length") ?? 0);
  const body =
    stream === null || length > functionRequestMaxBytes
      ? undefined
      : await readAtMost(stream, functionRequestMaxBytes);
  if (body === undefined) {
    return errorResponse(
      413,
      requestErrors.create("request.too_large"),
      requestId
    );
  }
  const artifact = await leasedArtifact(
    env,
    person.userId,
    id,
    request.headers.get(screenLeaseHeader)
  );
  return { person, id, body: new TextDecoder().decode(body), artifact };
};

/**
 * How often a stream's relay checks again that its person is signed in,
 * with the role and teams the stream started under, and that the
 * screen's build still gets the App's data: on a timer, whether frames
 * come or not, and before the result whatever the time.
 */
const streamRecheckMs = 5000;

/**
 * Whether the person whose session `headers` carry is still `call`'s,
 * with the access `access` fingerprints (organization role, teams and
 * role in the App, `accessOf`), its build still gets the App's data, and
 * no release the stream runs under (`versions`) was revoked: throws the
 * refusal otherwise. The build's delivery reads the App's current
 * release only, which a publish moves on from the one the stream runs.
 */
const stillDelivering = async (
  env: Env,
  headers: Headers,
  {
    call,
    access,
    versions,
  }: {
    readonly call: AdmittedCall;
    readonly access: string;
    readonly versions: readonly number[];
  },
  stage: "push" | "delivery"
): Promise<void> => {
  const now = await identify(env, headers);
  if (now?.userId !== call.person.userId) {
    throw authErrors.create("auth.unauthenticated");
  }
  // Refuses, too, someone with no role in the App any more.
  if ((await accessOf(env, now, call.id)) !== access) {
    throw operationErrors.create("operation.access_changed");
  }
  await requireDelivery(env, now, call.id, call.artifact, {
    operation: "stream",
    stage,
  });
  await requireReleasesLive(env, call.id, versions);
};

/** What the relay of one stream needs besides its frames. */
interface RelayOf {
  readonly env: Env;
  readonly headers: Headers;
  readonly call: AdmittedCall;
  /** The access the request was admitted under (`accessOf`). */
  readonly access: string;
  /** The release versions the stream runs under, the caller's among them. */
  readonly versions: readonly number[];
  readonly requestId: string;
  /** Cancels the invocation: the person or the build lost access. */
  readonly cancel: () => Promise<unknown>;
}

/**
 * The invocation's frames as the screen gets them (see the header): each
 * line passed on as it is read, the result only after a check of its own
 * and within what a screen takes in one answer, and the person and the
 * build checked again every `streamRecheckMs` meanwhile, frames or not.
 * A refusal ends the relay with a `refused` line carrying it, and cancels
 * the invocation at once.
 */
const relay = (
  frames: ReadableStream<Uint8Array>,
  { env, headers, call, access, versions, requestId, cancel }: RelayOf
): ReadableStream<Uint8Array> => {
  const reader = frames.pipeThrough(new TextDecoderStream()).getReader();
  const encoder = new TextEncoder();
  let buffered = "";
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = async (): Promise<void> => {
    done = true;
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      // Closed already.
    }
  };
  const nextLine = async (): Promise<string | undefined> => {
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        return line;
      }
      // oxlint-disable-next-line no-await-in-loop -- one chunk after another
      const { done: ended, value } = await reader.read();
      if (ended) {
        return undefined;
      }
      buffered += value;
    }
  };
  let refuse: ((error: unknown) => Promise<void>) | undefined;
  return new ReadableStream(
    {
      start: (controller) => {
        refuse = async (error) => {
          if (done) {
            return;
          }
          const refusal = refusalOf(error, requestId);
          try {
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "refused", error: refusal })}\n`
              )
            );
            controller.close();
          } catch {
            // The screen dropped the stream already: nobody reads the
            // refusal, but the invocation is cancelled all the same.
          }
          await finish();
          try {
            await cancel();
          } catch (cancelError) {
            log.warn("app_function.stream_cancel_failed", {
              requestId,
              ...errorFields(cancelError),
            });
          }
        };
        // Runs on a timer nobody awaits: it never throws.
        const check = async (): Promise<void> => {
          try {
            await stillDelivering(
              env,
              headers,
              { call, access, versions },
              "push"
            );
          } catch (error) {
            try {
              await refuse?.(error);
            } catch (refuseError) {
              log.warn("app_function.stream_refuse_failed", {
                requestId,
                ...errorFields(refuseError),
              });
            }
            return;
          }
          if (!done) {
            timer = setTimeout(() => {
              void check();
            }, streamRecheckMs);
          }
        };
        timer = setTimeout(() => {
          void check();
        }, streamRecheckMs);
      },
      pull: async (controller) => {
        const line = await nextLine();
        if (done) {
          return;
        }
        if (line === undefined) {
          controller.close();
          await finish();
          return;
        }
        const frame = frameOf(line);
        if (frame.type !== "result") {
          controller.enqueue(encoder.encode(`${line}\n`));
          return;
        }
        try {
          await stillDelivering(
            env,
            headers,
            { call, access, versions },
            "delivery"
          );
        } catch (error) {
          await refuse?.(error);
          return;
        }
        // As a plain call's answer: no more than a screen takes in one.
        const fits =
          jsonBytes(frame.result, screenLimits.answerBytes) <=
          screenLimits.answerBytes;
        const out = fits
          ? line
          : JSON.stringify({
              type: "result",
              seq: 1,
              result: {
                ok: false,
                error: refusalOf(
                  screenErrors.create("screen.answer_too_large"),
                  requestId
                ),
              },
            });
        controller.enqueue(encoder.encode(`${out}\n`));
        controller.close();
        await finish();
      },
      cancel: async () => {
        await finish();
      },
    },
    { highWaterMark: 0 }
  );
};

/** The call a stream request carries, with the key it must have. */
const streamRequestOf = (
  body: string
): { call: FunctionRequest; key: string } => {
  const call = readFunctionRequest(body);
  const key = idempotencyKeySchema.safeParse(call.idempotencyKey);
  if (!key.success || call.reference.kind !== "action") {
    throw operationErrors.create("contract.invalid_request");
  }
  return { call, key: key.data };
};

/**
 * `POST /api/app-functions/<app>/<stream | attach | cancel>`: one of the
 * App's streaming actions (spec 10.7.6), for the person signed in, as
 * their screen running the build its lease names, each admitted as a
 * start is, against the person's role now. `stream` starts the
 * invocation its key names (or joins it, with the same input) and
 * `attach` reads it again without ever starting it, each answering its
 * frames as JSON lines (action-invocation.ts), relayed only while the
 * person and the build still get the App's data; `cancel` asks it to
 * stop, answering `{ requested }`: whether it was still running, never
 * what stopping did, which its result says.
 */
const appStreamResponse = async (
  request: Request,
  env: Env,
  app: string,
  action: StreamCallAction,
  requestId: string
): Promise<Response> => {
  try {
    const admittedCall = await admitCall(request, env, app, requestId);
    if (admittedCall instanceof Response) {
      return admittedCall;
    }
    const { person, id, body, artifact } = admittedCall;
    await requireDelivery(env, person, id, artifact, {
      operation: "stream",
      stage: "admission",
    });
    const { call, key } = streamRequestOf(body);
    const name = await invocationName(person.userId, id, call, key, true);
    const invocation = actionInvocation(env, name);
    if (action === "cancel") {
      return Response.json({
        requested: await invocation.cancel(person.userId),
      });
    }
    // Admitted as a start is, against the person's access now, which the
    // invocation compares with the access it started under.
    const access = await accessOf(env, person, id);
    const frames = await invocation.open({
      by: { userId: person.userId, role: person.role, teams: person.teams },
      access,
      app: id,
      name,
      call,
      streaming: true,
      attach: action === "attach",
    });
    // The release it runs under, besides the caller's: a join or an attach
    // may follow a run a release published since started.
    const versions = await releasesOf(invocation, person.userId, call);
    return new Response(
      relay(frames, {
        env,
        headers: request.headers,
        call: admittedCall,
        access,
        versions,
        requestId,
        cancel: async () => await invocation.cancel(person.userId),
      }),
      {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
  } catch (error) {
    return refusalResponse(error, requestId, "app_function.stream_failed");
  }
};

/**
 * The response to `request` when `pathname` is a screen's call of one of
 * its App's functions: a call (`<path>/<app>`) or one of a streaming
 * action's (`<path>/<app>/<stream | attach | cancel>`); undefined for any
 * other path.
 */
export const appFunctionRoute = async (
  request: Request,
  env: Env,
  pathname: string,
  requestId: string
): Promise<Response | undefined> => {
  const app = functionCallApp(pathname);
  if (app !== undefined) {
    return await appFunctionResponse(request, env, app, requestId);
  }
  const stream = functionStreamCall(pathname);
  if (stream !== undefined) {
    return await appStreamResponse(
      request,
      env,
      stream.app,
      stream.action,
      requestId
    );
  }
  return undefined;
};
