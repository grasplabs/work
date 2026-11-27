import { authErrors, requestErrors } from "@grasp-os/shared/errors";

import { identify } from "../auth/identity.ts";
import { errorResponse } from "../errors.ts";
import { isLocalDevRequest } from "../router-secret.ts";
import { interviewCaller } from "./interview-caller.ts";
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

/** A POST from a page of a local stack's own: what every route here answers, and nothing else. */
const isLocalPost = (request: Request, env: Env): boolean => {
  const fetchSite = request.headers.get("sec-fetch-site");
  return (
    isLocalDevRequest(request, env) &&
    request.method === "POST" &&
    (fetchSite === null || sameSiteFetches.has(fetchSite))
  );
};

const notFound = (requestId: string): Response =>
  errorResponse(404, requestErrors.create("request.not_found"), requestId);

export const devResetResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (!isLocalPost(request, env)) {
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

/**
 * `POST /api/dev/onboarding/interview-link`, on a local stack only: the
 * path of the interview link of whoever is signed in there, or else of
 * noor@acme.test, or else of the first person on the list, so the page
 * opens `/interview#dev` as that link (the web's routes/interview.tsx)
 * however often the onboarding started over or was seeded again. On a
 * local stack any account signed in opens any link (the store's
 * `#heldAt`). On a deployed core the route isn't there.
 */
export const devInterviewLinkResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (!isLocalPost(request, env)) {
    return notFound(requestId);
  }
  const caller = await interviewCaller(env, request.headers);
  if (typeof caller === "string") {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  const path = await onboardingStore(env).devLinkFor(caller.address ?? "");
  return path === null
    ? notFound(requestId)
    : Response.json(
        { path },
        { headers: { "referrer-policy": "no-referrer" } }
      );
};

/**
 * `POST /api/dev/onboarding/voice-budget`, on a local stack only: today's
 * seconds of voice, heard and said, given back to everyone, so the live
 * interview can be tried again without starting the whole onboarding over.
 * On a deployed core the route isn't there, and the object refuses besides.
 */
export const devVoiceBudgetResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (!isLocalPost(request, env)) {
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
  const done = await onboardingStore(env).clearVoiceUseLocally();
  return done ? new Response(null, { status: 204 }) : notFound(requestId);
};
