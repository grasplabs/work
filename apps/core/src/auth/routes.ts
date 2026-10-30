import type { SignInConfig } from "@grasp-os/shared/deployment-config";
import { requestErrors } from "@grasp-os/shared/errors";
import { z } from "zod";

import { errorResponse } from "../errors.ts";
import { relayedAuthorizationUrl } from "../oauth-relay.ts";
import { authBasePath, authFor } from "./auth.ts";
import { signInConfig } from "./config.ts";

/**
 * The Better Auth routes core serves; everything else under `/api/auth` is
 * not found. Better Auth and its plugins bring many more (password sign-up,
 * registering SSO providers, creating organizations, invitations), and an
 * allowlist keeps each one off until we choose it. Team changes go through
 * the organization plugin's own permission checks (`auth.ts`). Removing
 * members and changing roles go only through core's own API
 * (`members.ts`), which keeps the organization an admin: no route here
 * may change a membership or a role. The JWT plugin's `/token` and
 * `/jwks` stay off too: a token for the whole session, or the keys App
 * tokens are checked with, are nothing a browser needs (app-tokens.ts).
 * Nor are Better Auth's own session routes (`/list-sessions`,
 * `/revoke-session(s)`, `/revoke-other-sessions`): they name sessions by
 * their tokens, which are what the cookie holds. A person lists and ends
 * their own sessions over `/rpc` instead (own-sessions.ts).
 */
const allowedRoutes = new Set([
  "POST /sign-in/sso",
  "GET /get-session",
  "POST /sign-out",
  "GET /organization/get-full-organization",
  "GET /organization/list-members",
  "GET /organization/list-teams",
  "POST /organization/create-team",
  "POST /organization/update-team",
  "POST /organization/remove-team",
  "GET /organization/list-team-members",
  "POST /organization/add-team-member",
  "POST /organization/remove-team-member",
]);

/**
 * The IdP redirects back here, one path per provider: straight, or through
 * the OAuth relay.
 */
const callbackPath = /^\/sso\/callback\/[a-z-]+$/u;

const isAllowed = (method: string, path: string): boolean =>
  allowedRoutes.has(`${method} ${path}`) ||
  (method === "GET" && callbackPath.test(path));

/** What `POST /sign-in/sso` asks for: the provider to sign in through. */
const startSchema = z.looseObject({ providerId: z.string() });

/** Better Auth's answer to it: the IdP's URL to send the browser to. */
const startedSchema = z.looseObject({ url: z.url() });

/**
 * A sign-in's start in relay mode: its IdP URL's state put through the
 * relay for the provider asked for (../oauth-relay.ts), so the relay
 * knows whose callback, and which, to send the browser back to; the
 * relay takes it off again, and Better Auth gets back the state it made.
 * Any answer but a started sign-in goes as it is; a started one that
 * can't be relayed throws, as it could never come back.
 */
const relayed = async (
  env: Env,
  request: Request,
  response: Response,
  config: SignInConfig
): Promise<Response> => {
  if (config.callbackOrigin === undefined || !response.ok) {
    return response;
  }
  const start = startSchema.safeParse(await request.json().catch(() => null));
  const started = startedSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => null)
  );
  if (!(start.success && started.success)) {
    return response;
  }
  const url = await relayedAuthorizationUrl(env, config, started.data.url, {
    kind: "sign-in",
    provider: start.data.providerId,
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(
    { ...started.data, url },
    { status: response.status, headers }
  );
};

/** Serves `/api/auth/*`. */
export const handleAuthRequest = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  const path = new URL(request.url).pathname.slice(authBasePath.length);
  const config = signInConfig(env);
  const auth = await authFor(env, config);
  if (!(auth && config && isAllowed(request.method, path))) {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const starting = request.method === "POST" && path === "/sign-in/sso";
  // Read again once Better Auth has, for the provider it was asked for.
  const asked = starting ? request.clone() : request;
  const response = await auth.handler(request);
  return starting ? await relayed(env, asked, response, config) : response;
};
