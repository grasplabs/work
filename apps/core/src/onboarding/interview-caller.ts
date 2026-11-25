import { authFor, mayNotAct } from "../auth/auth.ts";
import { signInConfig } from "../auth/config.ts";
import type { LinkCaller } from "./store.ts";

// Who calls a route of someone's interview (GRA-1790): `/api/interview`,
// its turns, stories and recordings, a line said on it, and its live
// transcription. Every one of them needs a session from the company's
// sign-in, and the store opens an interview only to the account it belongs
// to, or, the first time, to an account whose verified address the link
// went to (the store's `#heldAt`). From the threat model:
//
// - Someone else holding the link (forwarded, or handed out by the admin):
//   their session's account isn't the interview's, nor their address the
//   one it went to; the store answers as for a link that never was.
// - Another site making a signed-in person's browser drive their
//   interview: a request another site sent is refused before anything is
//   read. The browser says where it comes from (`Sec-Fetch-Site`); one
//   that doesn't (a browser from before 2023, a tool) must name the
//   deployment's own origin (`Origin`, which every browser sends with a
//   POST and a WebSocket upgrade), or it is refused as from elsewhere:
//   the session's cookie being `SameSite=Lax` is not all that holds.
// - Grasp's staff: a staff session opens no interview here. Staff read
//   interviews only through their own audited views.
// - A session for someone's interview alone reaching anything else: this
//   is the only place it is read (identity.ts `sessionIdentity` answers
//   nobody for it).
// - A guest (roles.ts `guestRole`), or anyone else who may no longer act
//   (removed, suspended): no interview opens for them, whatever address
//   their account holds. Someone signed in for their interview alone is
//   no member, and may act (membership-sql.ts `mayAct`).

/** Where a request may come from: the page itself, or a navigation typed in. */
const sameSiteFetches = new Set(["same-origin", "none"]);

/**
 * Whether `headers` are of a request this deployment's own pages made: by
 * `Sec-Fetch-Site` where the browser sends it, else by an `Origin` that is
 * the deployment's own. A request with neither is from nowhere we know.
 */
export const fromOwnSite = (
  headers: Headers,
  origin: string | undefined
): boolean => {
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    return sameSiteFetches.has(fetchSite);
  }
  return origin !== undefined && headers.get("origin") === origin;
};

/** Why a request names nobody who may open an interview. */
export type NoCaller = "cross_site" | "sign_in";

/**
 * Who calls: the account behind the request's session cookie and the
 * address the company's sign-in verified for it; `cross_site` for a request
 * another site sent; `sign_in` with no session, Grasp staff's, or one of
 * someone who may not act.
 */
export const interviewCaller = async (
  env: Env,
  headers: Headers
): Promise<LinkCaller | NoCaller> => {
  const config = signInConfig(env);
  if (!fromOwnSite(headers, config?.origin)) {
    return "cross_site";
  }
  const auth = await authFor(env, config);
  const found = await auth?.api.getSession({ headers });
  if (!found || found.session.staff || (await mayNotAct(env, found.user.id))) {
    return "sign_in";
  }
  return { account: found.user.id, address: found.user.email };
};
