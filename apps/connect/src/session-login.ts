import {
  filledHost,
  loginPlaceholderOf,
  retryAfterOf,
} from "@grasp-os/runtime/connector";
import type { LoginSignIn } from "@grasp-os/runtime/connector";
import { log } from "@grasp-os/shared/log";

import type { Outbound } from "./company-network.ts";
import { idTokenClaims, readCapped, valueAt } from "./oauth-client.ts";
import type { Credential } from "./providers.ts";

// A connector's sign-in with a call (`auth.login`, runtime's sign-in.ts):
// connect sends the fields the person gave in the one POST the connector
// declares, the connection's way out (`send`: through the company network
// for a connection reached through it), and reads the session from the
// answer. Connector code never runs here, never sees the fields, and never
// sees this answer. Threat model on GRA-2306, section 6:
//
// - LG1: the POST goes only to the record's URL, its host filled with the
//   connection's own, on a host the session goes to (the manifest checks
//   it), and no redirect is followed: one leads nowhere.
// - LG3: each field is the whole of a value in the body, as JSON or a
//   form, never spliced into text, so a password holding quotes or a
//   placeholder is sent as it is. A session that can't go in a header as
//   it is (a control character, a line break, a space) is refused.
// - LG4: a cookie session is the one cookie the record names, its domain,
//   path and every other attribute ignored: it goes, as that cookie alone,
//   to the hosts the connector's credential goes to, and nowhere else.
// - LG6: a session lasts what the answer says, or what its JWT's `exp`
//   says, held between `minSessionMs` and `maxSessionMs`: an expiry only
//   says when connect logs in again, never that the token is trusted, and
//   a 401 ends a session whatever it says (egress.ts).
// - LG7: neither the request nor the answer is logged: only the status.

/** Longest a session is kept before connect logs in again. */
const maxSessionMs = 24 * 60 * 60 * 1000;
/**
 * Shortest: one that says it lasts less is still used this long, and a
 * 401 ends it, so a short or past expiry never has every call log in.
 */
const minSessionMs = 2 * 60 * 1000;
/** How long the login may take: well within a renewal's lease (tokens.ts). */
const loginTimeoutMs = 10_000;
/** Longest session connect takes. */
const maxSessionLength = 4096;

/** A session that may go in a header as it is: visible ASCII, no space. */
const headerSafe = /^[\u0021-\u007E]+$/u;

/** A cookie's value (RFC 6265 §4.1.1 `cookie-value`), in quotes or not. */
const cookieSafe = /^(?:"[!#-+\--:<-[\]-~]+"|[!#-+\--:<-[\]-~]+)$/u;

/** What a login answered: a session, or why there is none. */
export type LoginAnswer =
  | { session: string; expiresAt: number }
  /** Answered, without a session: the fields are wrong, or the record is. */
  | { refused: true }
  /** Not answered for now (429, 5xx, unreachable): after `retryAfterSeconds`, if it says. */
  | { refused: false; retryAfterSeconds?: number };

/** The session as a call's requests carry it. */
export const sessionCredential = (
  token: LoginSignIn["token"],
  session: string
): Credential =>
  "cookie" in token
    ? { header: "cookie", value: `${token.cookie}=${session}` }
    : { header: token.header, value: `${token.prefix ?? ""}${session}` };

/** The login's body: each placeholder replaced by the whole of its field. */
const bodyOf = (
  request: LoginSignIn["request"],
  fields: Readonly<Record<string, string>>
): { type: string; body: string } => {
  const filled = (
    value: string | number | boolean | null
  ): string | number | boolean | null => {
    const name = loginPlaceholderOf(value);
    return name === undefined ? value : (fields[name] ?? "");
  };
  if (request.form !== undefined) {
    return {
      type: "application/x-www-form-urlencoded",
      body: new URLSearchParams(
        Object.entries(request.form).map(([name, value]) => [
          name,
          String(filled(value)),
        ])
      ).toString(),
    };
  }
  return {
    type: "application/json",
    body: JSON.stringify(
      Object.fromEntries(
        Object.entries(request.json ?? {}).map(([name, value]) => [
          name,
          filled(value),
        ])
      )
    ),
  };
};

/**
 * The value of the cookie `name` the answer sets, parsed as RFC 6265 §5.2
 * says: each `Set-Cookie`'s name and value, up to its first `;`, split at
 * the first `=`, without the whitespace around them; the last one of that
 * name. Its attributes are ignored.
 */
const cookieOf = (response: Response, name: string): string | undefined => {
  let value: string | undefined;
  for (const line of response.headers.getSetCookie()) {
    const [pair = ""] = line.split(";", 1);
    const equals = pair.indexOf("=");
    if (equals !== -1 && pair.slice(0, equals).trim() === name) {
      value = pair.slice(equals + 1).trim();
    }
  }
  return value;
};

/** The JSON the answer holds, if it is JSON. */
const answerJson = async (response: Response): Promise<unknown> => {
  try {
    return JSON.parse(await readCapped(response));
  } catch {
    return undefined;
  }
};

/**
 * When the session ends: as the answer says at `expiresIn`, else as its
 * JWT's `exp` says, else at the longest, always within the bounds.
 */
const expiryOf = (
  json: unknown,
  expiresIn: string | undefined,
  session: string,
  now: number
): number => {
  const stated = expiresIn === undefined ? undefined : valueAt(json, expiresIn);
  const claims = idTokenClaims(session);
  const exp: unknown =
    typeof claims === "object" && claims !== null
      ? Reflect.get(claims, "exp")
      : undefined;
  let lasts = maxSessionMs;
  if (typeof stated === "number" && Number.isFinite(stated)) {
    lasts = stated * 1000;
  } else if (typeof exp === "number" && Number.isFinite(exp)) {
    lasts = exp * 1000 - now;
  }
  return now + Math.min(Math.max(lasts, minSessionMs), maxSessionMs);
};

/**
 * The session a login's successful answer holds, where `signIn` says, if
 * it can go on a request as it is.
 */
const sessionFrom = async (
  response: Response,
  { token, expiresIn }: LoginSignIn,
  now: number
): Promise<LoginAnswer> => {
  const cookie =
    "cookie" in token ? cookieOf(response, token.cookie) : undefined;
  let json: unknown = undefined;
  if ("from" in token || expiresIn !== undefined) {
    json = await answerJson(response);
  } else {
    await response.body?.cancel();
  }
  const found = "cookie" in token ? cookie : valueAt(json, token.from);
  const session = typeof found === "string" ? found : "";
  const fits =
    session !== "" &&
    session.length <= maxSessionLength &&
    ("cookie" in token ? cookieSafe.test(session) : headerSafe.test(session));
  return fits
    ? { session, expiresAt: expiryOf(json, expiresIn, session, now) }
    : { refused: true };
};

/**
 * Logs in as `signIn` declares with `fields`, sent by `send`, the URL's
 * host filled with the connection's (`hosts`): the session its answer
 * holds, or why there is none.
 */
export const logIn = async (
  provider: string,
  signIn: LoginSignIn,
  fields: Readonly<Record<string, string>>,
  send: Outbound,
  hosts: Readonly<Record<string, string>>
): Promise<LoginAnswer> => {
  const url = new URL(signIn.request.url);
  const host = filledHost(url.hostname, hosts);
  if (host === undefined) {
    return { refused: true };
  }
  url.hostname = host;
  const { type, body } = bodyOf(signIn.request, fields);
  const now = Date.now();
  let response: Response;
  try {
    response = await send(
      new Request(url, {
        method: "POST",
        headers: { "content-type": type, accept: "application/json" },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(loginTimeoutMs),
      })
    );
  } catch {
    log.warn("login.failed", { provider });
    return { refused: false };
  }
  log.info("login.answered", { provider, status: response.status });
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    const retryAfterSeconds = retryAfterOf(response);
    return retryAfterSeconds === undefined
      ? { refused: false }
      : { refused: false, retryAfterSeconds };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { refused: true };
  }
  return await sessionFrom(response, signIn, now);
};
