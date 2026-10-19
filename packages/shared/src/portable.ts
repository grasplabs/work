import type { QuerySnapshotPush, RunSubscriptionApi } from "./screens.ts";

// Where a portable host (spec 10.7.1: an App's UI outside Grasp's own
// shell, as `new GraspClient({ url, getToken })` reaches it) gets its
// token, calls its App's functions and follows its live queries. Named
// once for core and the SDK.

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

/**
 * Where a portable host follows its App's live queries (spec 11) with
 * that token: a WebSocket to `<path>/<app ID>`, speaking Cap'n Web, the
 * token in its first call (`PortableLiveApi.connect`), never in the URL
 * or a cookie (core's portable-live.ts).
 */
export const portableLivePath = "/api/portable/app-live";

/**
 * The close code of a live connection whose token passed its `exp`
 * without a renewal: not lost access, so the host asks for a fresh token
 * and follows again, rather than clearing what it shows.
 */
export const tokenExpiredCloseCode = 4408;

/**
 * The close code of a live connection whose access ended: its token was
 * refused, or its session ended or was revoked while nothing was pushed.
 * The host clears what it shows, as for an `auth.unauthenticated`
 * refusal (the same code core's `/rpc` closes with when a session ends).
 */
export const accessEndedCloseCode = 4401;

/**
 * The close code of a live connection core couldn't authenticate yet
 * (its token unreadable for now, or `connect` slower than it waits): no
 * refusal of the person, so the host connects again.
 */
export const connectAgainCloseCode = 4503;

/**
 * What a portable host's live connection reaches before it authenticates:
 * `connect`, once, with the person's App token for the connection's App.
 * Refused `auth.unauthenticated` for anything else, and the connection
 * closed.
 */
export interface PortableLiveApi {
  connect: (token: string) => Promise<PortableQueriesApi>;
}

/** A portable host's live queries of its App, as the token's person. */
export interface PortableQueriesApi {
  /**
   * Follows the query `request` names (`ScreenFrameApi.watchQuery`):
   * each result is pushed to `onSnapshot` until the subscription is
   * released, or core lets go of `onSnapshot`.
   */
  watchQuery: (
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ) => Promise<RunSubscriptionApi>;
  /**
   * Swaps the connection's token for a newer one of the same person's,
   * before the one it holds expires: answers the new one's expiry, in
   * epoch milliseconds. Someone else's token is refused
   * `auth.principal_changed`, and the connection closed.
   */
  renew: (token: string) => Promise<{ expiresAt: number }>;
}

/** How long an App token is good for, at most: its session may end sooner. */
export const appTokenMs = 5 * 60 * 1000;

/**
 * The `typ` claim of an App token: what tells it from any other JWT the
 * same keys might sign.
 */
export const appTokenType = "grasp-app";
