import { authErrors, requestErrors } from "@grasp-os/shared/errors";

import { identify } from "../auth/identity.ts";
import { errorResponse } from "../errors.ts";
import { isLocalDevRequest } from "../router-secret.ts";
import { onboardingStore } from "./store.ts";

// The onboarding started over, `POST /api/dev/onboarding/start-over`: on
// a local stack only (`vp run dev`, the requests the router-secret check
// lets through there), for whoever is signed in there, so whoever works on the
// onboarding can walk the setup and an interview again and again without
// stopping the stack and deleting its state. Everything the onboarding
// object kept goes: the setup's place and choices, the plan, the links,
// what was said. What the Brain was given from it stays. On a deployed
// core the route isn't there, and the object refuses besides.

/** The same sites `fetch` reports for a request a page of our own made, or none at all. */
const sameSiteFetches = new Set(["same-origin", "none"]);

const notFound = (requestId: string): Response =>
  errorResponse(404, requestErrors.create("request.not_found"), requestId);

export const devResetResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    !isLocalDevRequest(request, env) ||
    request.method !== "POST" ||
    (fetchSite !== null && !sameSiteFetches.has(fetchSite))
  ) {
    return notFound(requestId);
  }
  const person = await identify(env, request.headers);
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  const done = await onboardingStore(env).startOverLocally();
  return done ? new Response(null, { status: 204 }) : notFound(requestId);
};
