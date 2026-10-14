import {
  authErrors,
  internalErrors,
  isExpectedError,
  requestErrors,
} from "@grasp-os/shared/errors";
import { readAtMost } from "@grasp-os/shared/http";
import { errorFields, log } from "@grasp-os/shared/log";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import {
  appFunctionPath,
  jsonBytes,
  screenErrors,
  screenLeaseHeader,
  screenLimits,
} from "@grasp-os/shared/screens";

import { callAppFunction } from "./app-functions.ts";
import type { FunctionAnswer } from "./app-functions.ts";
import { identify } from "./auth/identity.ts";
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

/** How long a screen waits for a function's answer. */
const screenCallMs = 30_000;

/** The App ID in `pathname`, if it is a function call's path. */
export const functionCallApp = (pathname: string): string | undefined => {
  const prefix = `${appFunctionPath}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const app = pathname.slice(prefix.length);
  return app.length > 0 && !app.includes("/") ? app : undefined;
};

/** The status a refusal before the call answers with. */
const statusOf = (code: string): number => {
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
  const json =
    request.headers.get("content-type")?.split(";")[0]?.trim() ===
    "application/json";
  if (!(isOwnOrigin(request, env) && json)) {
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
    const artifact = await leasedArtifact(
      env,
      person.userId,
      id,
      request.headers.get(screenLeaseHeader)
    );
    const answer = await delivering(
      env,
      person,
      id,
      artifact,
      "call",
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
    if (isExpectedError(error)) {
      return errorResponse(statusOf(error.code), error, requestId);
    }
    log.error("app_function.failed", { requestId, ...errorFields(error) });
    return errorResponse(
      500,
      internalErrors.create("internal.unexpected"),
      requestId
    );
  }
};
