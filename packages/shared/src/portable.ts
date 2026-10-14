// Where a portable host (spec 10.7.1: an App's UI outside Grasp's own
// shell, as `new GraspClient({ url, getToken })` reaches it) gets its
// token and calls its App's functions. Named once for core and the SDK.

/**
 * Where the person's own session gets a token for one App: `POST
 * <path>/<app ID>`, from the deployment's own pages (core's
 * auth/app-tokens.ts).
 */
export const appTokenPath = "/api/app-tokens";

/**
 * Where a portable host calls one of its App's functions with that token:
 * `POST <path>/<app ID>`, the request as the body, `Authorization: Bearer
 * <token>` (core's app-function-route.ts).
 */
export const portableFunctionPath = "/api/portable/app-functions";

/** How long an App token is good for, at most: its session may end sooner. */
export const appTokenMs = 5 * 60 * 1000;

/**
 * The `typ` claim of an App token: what tells it from any other JWT the
 * same keys might sign.
 */
export const appTokenType = "grasp-app";
