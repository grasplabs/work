import { actorOf } from "@grasp-os/shared/audit";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { appTokenPath } from "@grasp-os/shared/portable";
import { drizzle } from "drizzle-orm/d1";

import { appAfter, isJson, refusalResponse } from "./app-function-route.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { issueAppToken } from "./auth/app-tokens.ts";
import { signedInSession } from "./auth/identity.ts";
import { errorResponse } from "./errors.ts";
import { isOwnOrigin } from "./rpc.ts";
import { admitted } from "./screens-rpc.ts";

// `POST /api/app-tokens/<app>`: the person's own session gets a token for
// one App of theirs, for a portable host to call its functions with
// (auth/app-tokens.ts says what a token is and isn't good for). Only from
// the deployment's own pages, with a JSON body, as the cookie function
// route: another site can't mint a token in the person's name, or read
// one. Only for an App they have a role in, counted against their
// requests of it. Every token issued is recorded. The answer is never
// cached.

/** The App ID in `pathname`, if it is a token request's path. */
export const tokenRequestApp = (pathname: string): string | undefined =>
  appAfter(pathname, appTokenPath);

/**
 * Answers `{ token, expiresAt }`: a token for the person signed in to
 * call `app`'s functions from a portable host. A refusal as an error
 * response.
 */
export const appTokenResponse = async (
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
  const session = await signedInSession(env, request.headers);
  if (session === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  try {
    const id = await admitted(env, session.person, app);
    const issued = await issueAppToken(env, session, id);
    if (issued === undefined) {
      throw authErrors.create("auth.unauthenticated");
    }
    await keepAuditEvent(env, drizzle(env.DB), {
      actor: actorOf(session.person),
      action: "app.token.issued",
      target: { type: "app", id },
      detail: { expiresAt: issued.expiresAt.toISOString() },
    });
    return Response.json(
      { token: issued.token, expiresAt: issued.expiresAt.toISOString() },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return refusalResponse(error, requestId, "app_token.failed");
  }
};
