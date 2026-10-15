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
import { portableFunctionPath } from "@grasp-os/shared/portable";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  appFunctionPath,
  jsonBytes,
  screenErrors,
  screenLeaseHeader,
  screenLimits,
} from "@grasp-os/shared/screens";

import { callAppFunction } from "./app-functions.ts";
import type { FunctionAnswer } from "./app-functions.ts";
import { checkAppToken } from "./auth/app-tokens.ts";
import type { TokenCheck } from "./auth/app-tokens.ts";
import { identify } from "./auth/identity.ts";
import { appHost } from "./durable-objects.ts";
import { errorResponse } from "./errors.ts";
import { isOwnOrigin } from "./rpc.ts";
import { delivering, leasedArtifact } from "./screen-trust.ts";
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
}

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
  { person, lease, operation, portableSession }: Caller,
  requestId: string
): Promise<Response> => {
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
            new TextDecoder().decode(body),
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
  return await boundedCall(
    request,
    env,
    app,
    {
      person,
      // A missing lease is no build: unreviewed.
      lease: request.headers.get(screenLeaseHeader),
      operation: "call",
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
      },
      requestId
    )
  );
};
