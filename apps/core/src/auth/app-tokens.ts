import type { AppId } from "@grasp-os/shared/ids";
import { appTokenMs, appTokenType } from "@grasp-os/shared/portable";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { sessions, users } from "../db/core/schema.ts";
import { authFor, tokenKeysOf } from "./auth.ts";
import { signInConfig } from "./config.ts";
import { sessionIdentity } from "./identity.ts";
import type { SignedInSession } from "./identity.ts";

// App tokens: how a portable host (spec 10.7.1, `new GraspClient({ url,
// getToken })`) calls an App's functions in a person's name without their
// session cookie. A token is a JWT Better Auth's JWT plugin signs (its
// keys, its `jwks` table), with core's own claims. Threat model, and how
// each is closed:
//
// - A token used for more than it was made for. It is typed as an App
//   token (`typ`), names one person (`sub`), the session it came from
//   (`sid`) and one App (`app`), and its audience is the portable
//   routes alone (the function route, and the live connection,
//   portable-live.ts): another App, or any other route of core's,
//   refuses it. Nothing else of core's reads a bearer token, and the
//   cookie routes ignore it.
// - A stolen token replayed. It is good for `appTokenMs` at most, and
//   never past its session: a thief gets minutes, in one App, with what
//   that person may do there. Each call is still counted against that
//   person's request budget of the App, and a replayed mutation under the
//   same idempotency key is the same submission, not a second save. That
//   budget is shared with the person's own screens, so a thief can also
//   use it up for those minutes: accepted. Binding a token to a key its
//   host holds (DPoP) is not done: a browser host could not keep such a
//   key from its own page's script either.
// - What a token shows. Its claims are signed, not encrypted: the host's
//   script can read the person's ID and the session's ID (never the
//   session's token, which only its cookie carries). Neither is a
//   credential.
// - A token outliving what it was issued under. Nothing is trusted from
//   the token but who and which App: on every call the session is read
//   again (signed out, revoked or expired ends every token made from it),
//   and the person's role and membership again, as for a cookie.
// - Someone minting a token for someone else. Only the person's own
//   session mints, from the deployment's own pages (app-token-route.ts),
//   for an App they have a role in; each mint is recorded with the
//   session it came from.
// - A forged or altered token. Signatures are checked with the plugin's
//   keys only, by the `kid` the token names and the algorithm of that
//   key (never the token's `alg`); issuer, audience and expiry are
//   checked with it. A token is read only when it has a JWT's shape and
//   size, before any key is.
// - A signing key leaking. Private keys are kept encrypted with the auth
//   secret, and the plugin's `/jwks` and `/token` routes are off
//   (routes.ts). A key signs for 30 days; it verifies only while a token
//   it signed can still be current (token-keys.ts: its expiry plus a token's
//   lifetime), and its row is deleted after (`sweepTokenKeys`). So a
//   leaked key stops working at most 30 days and 5 minutes after it was
//   made, not forever. Within that, its holder can sign tokens for any
//   person whose live session's ID they know.

/** The longest token read: an Ed25519 JWT with core's claims is far shorter. */
const tokenMaxLength = 2048;

const jwtShape = /^[\w-]+\.[\w-]+\.[\w-]+$/u;

/** A token's lifetime ends as soon as its session's does. */
const expiryOf = (session: SignedInSession, now: number): number =>
  Math.min(now + appTokenMs, session.expiresAt.getTime());

/**
 * Deletes the JWT plugin's keys that can't verify anything any more
 * (token-keys.ts), through Better Auth's own adapter. Run by the cron.
 */
export const sweepTokenKeys = async (env: Env, now: Date): Promise<void> => {
  const auth = authFor(env, signInConfig(env));
  if (auth === undefined) {
    return;
  }
  const { adapter } = await auth.$context;
  await adapter.deleteMany({
    model: "jwks",
    where: [
      {
        field: "expiresAt",
        operator: "lte",
        value: new Date(now.getTime() - appTokenMs),
      },
    ],
  });
};

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
        typ: appTokenType,
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
  typ: z.literal(appTokenType),
  sub: z.string().min(1),
  sid: z.string().min(1),
  app: z.string().min(1),
  exp: z.number(),
});

/**
 * What a token presented for an App comes to: who it lets call, from
 * which session; or why not. `invalid` is anything that isn't a current
 * App token of core's; the others are genuine tokens refused, worth a
 * log line.
 */
export type TokenCheck =
  | {
      ok: true;
      person: Identity;
      sessionId: string;
      /** When the token expires, in epoch milliseconds (its `exp`). */
      expiresAt: number;
    }
  | { ok: false; reason: "invalid" }
  /** Signed, maybe, by a key another isolate made since this one read them. */
  | { ok: false; reason: "keys_pending" }
  | {
      ok: false;
      reason: "another_app" | "session_ended" | "no_access";
      userId: string;
      sessionId: string;
    };

/**
 * Who `token` lets call `app`'s functions now: the person of the session
 * it was made from, read as `identify` reads a cookie's. Refused for a
 * token that isn't one of core's App tokens for exactly `app`, has
 * expired, or whose session or person's access has ended.
 */
export const checkAppToken = async (
  env: Env,
  token: string,
  app: string
): Promise<TokenCheck> => {
  const invalid = { ok: false, reason: "invalid" } as const;
  const auth = authFor(env, signInConfig(env));
  if (
    auth === undefined ||
    token.length > tokenMaxLength ||
    !jwtShape.test(token)
  ) {
    return invalid;
  }
  const { payload } = await auth.api.verifyJWT({ body: { token } });
  const read = claimsSchema.safeParse(payload);
  if (!read.success) {
    // A key made in another isolate within the last few seconds isn't
    // read here yet (token-keys.ts): its holder tries again, it isn't
    // told to sign in, which would clear what its screens hold.
    return tokenKeysOf(env).takeStale(token)
      ? { ok: false, reason: "keys_pending" }
      : invalid;
  }
  const { sub: userId, sid: sessionId } = read.data;
  if (read.data.app !== app) {
    return { ok: false, reason: "another_app", userId, sessionId };
  }
  const [session] = await drizzle(env.DB)
    .select({
      expiresAt: sessions.expiresAt,
      staff: sessions.staff,
      email: users.email,
      name: users.name,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  if (session === undefined || session.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "session_ended", userId, sessionId };
  }
  const person = await sessionIdentity(env, { userId, ...session });
  return person === undefined
    ? { ok: false, reason: "no_access", userId, sessionId }
    : { ok: true, person, sessionId, expiresAt: read.data.exp * 1000 };
};
