import { authFor } from "../auth/auth.ts";
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
//   read; the session's cookie is `SameSite=Lax` besides, so a POST from
//   another site carries none.
// - Grasp's staff: a staff session opens no interview here. Staff read
//   interviews only through their own audited views.
// - A session for someone's interview alone reaching anything else: this
//   is the only place it is read (identity.ts `sessionIdentity` answers
//   nobody for it).

/** Where a request may come from: the page itself, or a navigation typed in. */
const sameSiteFetches = new Set(["same-origin", "none"]);

/** Why a request names nobody who may open an interview. */
export type NoCaller = "cross_site" | "sign_in";

/**
 * Who calls: the account behind the request's session cookie and the
 * address the company's sign-in verified for it; `cross_site` for a request
 * another site sent; `sign_in` with no session, or Grasp staff's.
 */
export const interviewCaller = async (
  env: Env,
  headers: Headers
): Promise<LinkCaller | NoCaller> => {
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null && !sameSiteFetches.has(fetchSite)) {
    return "cross_site";
  }
  const auth = await authFor(env, signInConfig(env));
  const found = await auth?.api.getSession({ headers });
  if (!found || found.session.staff) {
    return "sign_in";
  }
  return { account: found.user.id, address: found.user.email };
};
