import type { AppId } from "@grasp-os/shared/ids";
import { appTokenMs } from "@grasp-os/shared/portable";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { sessions, users } from "../db/core/schema.ts";
import { authFor } from "./auth.ts";
import { signInConfig } from "./config.ts";
import { sessionIdentity } from "./identity.ts";
import type { SignedInSession } from "./identity.ts";

// App tokens: how a portable host (spec 10.7.1, `new GraspClient({ url,
// getToken })`) calls an App's functions in a person's name without their
// session cookie. A token is a JWT Better Auth's JWT plugin signs (its
// keys, its `jwks` table), with core's own claims. Threat model, and how
// each is closed:
//
// - A token used for more than it was made for. It names one person
//   (`sub`), the session it came from (`sid`) and one App (`app`), and
//   its audience is the portable function route alone: another App, or
//   any other route of core's, refuses it. Nothing else of core's reads
//   a bearer token, and the cookie route ignores it.
// - A stolen token replayed. It is good for `appTokenMs` at most, and
//   never past its session: a thief gets minutes, in one App, with what
//   that person may do there. Each call is still counted against that
//   person's request budget of the App, and a replayed mutation under the
//   same idempotency key is the same submission, not a second save.
//   Binding a token to a key its host holds (DPoP) is not done: a browser
//   host could not keep such a key from its own page's script either.
// - A token outliving what it was issued under. Nothing is trusted from
//   the token but who and which App: on every call the session is read
//   again (signed out, revoked or expired ends every token made from it),
//   and the person's role and membership again, as for a cookie.
// - Someone minting a token for someone else. Only the person's own
//   session mints, from the deployment's own pages (app-token-route.ts),
//   for an App they have a role in; each mint is recorded.
// - A forged or altered token. Signatures are checked with the plugin's
//   keys only, by the `kid` the token names and the algorithm of that
//   key (never the token's `alg`); issuer, audience and expiry are
//   checked with it. A token is read only when it has a JWT's shape and
//   size, before any key is.
// - Keys leaking. Private keys are kept encrypted with the auth secret;
//   the plugin's `/jwks` and `/token` routes are off (routes.ts), and a
//   key is replaced every 30 days.

/** The longest token read: an Ed25519 JWT with core's claims is far shorter. */
const tokenMaxLength = 2048;

const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/u;

/** A token's lifetime ends as soon as its session's does. */
const expiryOf = (session: SignedInSession, now: number): number =>
  Math.min(now + appTokenMs, session.expiresAt.getTime());

/**
 * A token for `session`'s person to call `app`'s functions from a
 * portable host, and when it expires. `undefined` while sign-in isn't
 * configured.
 */
export const issueAppToken = async (
  env: Env,
  session: SignedInSession,
  app: AppId
): Promise<{ token: string; expiresAt: Date } | undefined> => {
  const auth = authFor(env, signInConfig(env));
  if (auth === undefined) {
    return undefined;
  }
  const now = Date.now();
  const expiresAt = expiryOf(session, now);
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        sub: session.person.userId,
        sid: session.sessionId,
        app,
        iat: Math.floor(now / 1000),
        exp: Math.floor(expiresAt / 1000),
      },
    },
  });
  return { token, expiresAt: new Date(expiresAt) };
};

/** The claims core reads of a verified token; the plugin checked the rest. */
const claimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  app: z.string().min(1),
});

/**
 * Who `token` lets call `app`'s functions now: the person of the session
 * it was made from, read as `identify` reads a cookie's. `undefined` for
 * a token that isn't one of core's App tokens for exactly `app`, has
 * expired, or whose session has ended.
 */
export const identifyAppToken = async (
  env: Env,
  token: string,
  app: string
): Promise<Identity | undefined> => {
  const auth = authFor(env, signInConfig(env));
  if (
    auth === undefined ||
    token.length > tokenMaxLength ||
    !jwtShape.test(token)
  ) {
    return undefined;
  }
  const { payload } = await auth.api.verifyJWT({ body: { token } });
  const read = claimsSchema.safeParse(payload);
  if (!read.success || read.data.app !== app) {
    return undefined;
  }
  const claims = { userId: read.data.sub, sessionId: read.data.sid };
  const [session] = await drizzle(env.DB)
    .select({
      expiresAt: sessions.expiresAt,
      staff: sessions.staff,
      email: users.email,
      name: users.name,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.id, claims.sessionId), eq(sessions.userId, claims.userId))
    );
  if (session === undefined || session.expiresAt.getTime() <= Date.now()) {
    return undefined;
  }
  return await sessionIdentity(env, { userId: claims.userId, ...session });
};
