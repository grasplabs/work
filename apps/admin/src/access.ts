/**
 * The admin's own check of Cloudflare Access (threat model R19, CO1, CO5).
 * Access stands in front of the admin, but the Worker trusts nothing it
 * hasn't verified itself: every request must carry an Access JWT signed by
 * the team's keys, for the admin's application, or it is refused.
 */
import { loopbackHosts } from "@grasp-os/shared/router";
import { createLocalJWKSet, errors, jwtVerify } from "jose";
import type { JSONWebKeySet } from "jose";
import { z } from "zod";

/** The staff member a request comes from, as Access vouches for them. */
export interface Staff {
  email: string;
  /** Access's stable id for the person; empty for the dev bypass. */
  sub: string;
}

/** What the gate reads from the admin's env. */
export interface AccessEnv {
  /** The Access application's AUD tag. */
  CF_ACCESS_AUD?: string;
  /** The team's URL, i.e. `https://<team>.cloudflareaccess.com`. */
  CF_ACCESS_ISS?: string;
  /**
   * Local dev only: the staff member every request to this machine comes
   * from, without Access. Never set in a deployment; if it is, the admin
   * refuses everything.
   */
  DEV_ACCESS_EMAIL?: string;
}

const assertionHeader = "cf-access-jwt-assertion";

/** Methods that change nothing, so a cross-site request can't abuse them. */
const safeMethods: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** How long a team's keys are kept before they are fetched again. */
const keysMaxAgeMs = 10 * 60 * 1000;

/** How long a key set's fetch may take. */
const keysTimeoutMs = 5000;

/**
 * How long after a refetch for a key id the kept keys didn't have the next
 * such refetch waits: a forged JWT naming a made-up key id, sent past
 * Access, is refused at once rather than fetching the keys each time.
 */
const missCooldownMs = 30 * 1000;

/**
 * Each team's keys as last fetched, per isolate: plain data only. Never a
 * fetch in flight, a response or a remote key set holding one: those
 * belong to the request that made them, and another request awaiting them
 * fails ("Cannot perform I/O on behalf of a different request") or hangs.
 * Each request that finds no fresh keys fetches them itself.
 * `lastMissFetchAt` is when a JWT's unknown key id last made a request
 * fetch them again (`missCooldownMs`); null before any.
 */
const keyCache = new Map<
  string,
  { keys: JSONWebKeySet; fetchedAt: number; lastMissFetchAt: number | null }
>();

const keySetSchema = z.object({
  keys: z.array(z.object({ kty: z.string() }).loose()),
});

/**
 * The team's keys, fetched now, in the asking request, and kept; `miss`
 * when a JWT named a key id the kept keys didn't have.
 */
const fetchKeys = async (
  issuer: string,
  miss: boolean
): Promise<JSONWebKeySet> => {
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(keysTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Access keys answered ${String(response.status)}`);
  }
  const keys: JSONWebKeySet = keySetSchema.parse(await response.json());
  const now = Date.now();
  keyCache.set(issuer, {
    keys,
    fetchedAt: now,
    lastMissFetchAt: miss
      ? now
      : (keyCache.get(issuer)?.lastMissFetchAt ?? null),
  });
  return keys;
};

/**
 * Verifies `token` with the team's keys: those kept while fresh, else
 * fetched; kept keys that have no key for it are fetched again once, as
 * Access rotates its keys, at most once every `missCooldownMs`: within
 * it, a JWT naming an unknown key id is refused without a fetch.
 */
const verifyAccessToken = async (
  token: string,
  issuer: string,
  audience: string
) => {
  const options = {
    issuer,
    audience,
    // Access signs with RS256; nothing else is accepted.
    algorithms: ["RS256"],
  };
  const kept = keyCache.get(issuer);
  if (kept === undefined || Date.now() - kept.fetchedAt >= keysMaxAgeMs) {
    return await jwtVerify(
      token,
      createLocalJWKSet(await fetchKeys(issuer, false)),
      options
    );
  }
  try {
    return await jwtVerify(token, createLocalJWKSet(kept.keys), options);
  } catch (error) {
    const coolingDown =
      kept.lastMissFetchAt !== null &&
      Date.now() - kept.lastMissFetchAt < missCooldownMs;
    if (!(error instanceof errors.JWKSNoMatchingKey) || coolingDown) {
      throw error;
    }
    return await jwtVerify(
      token,
      createLocalJWKSet(await fetchKeys(issuer, true)),
      options
    );
  }
};

/**
 * The staff member a verified Access JWT names, or null when the request has
 * no JWT, the JWT doesn't verify (signature, `aud`, `iss`, expiry), or it
 * names no person (a service token has no email).
 */
const verifiedStaff = async (
  request: Request,
  env: AccessEnv
): Promise<Staff | null> => {
  const token = request.headers.get(assertionHeader) ?? "";
  const audience = env.CF_ACCESS_AUD ?? "";
  const issuer = env.CF_ACCESS_ISS ?? "";
  if (token === "" || audience === "" || issuer === "") {
    return null;
  }
  try {
    const { payload } = await verifyAccessToken(token, issuer, audience);
    if (typeof payload.email !== "string" || payload.email === "") {
      return null;
    }
    return { email: payload.email, sub: payload.sub ?? "" };
  } catch {
    return null;
  }
};

/** Where TanStack Start serves server functions (its default base). */
const serverFunctionBase = "/_serverFn";

/** Where the admin's MCP is served (src/admin/mcp.ts). */
const mcpPath = "/mcp";

/**
 * Whether a request is an MCP client's call of the admin's MCP: a POST to
 * its path with a JSON body and no `Origin`. MCP clients send no `Origin`,
 * and a browser sends one on every POST, so no page elsewhere can make
 * one with a staff member's Access cookie; a browser's own POST from the
 * admin keeps its `Origin` and takes the rule below.
 */
const isMcpRequest = (request: Request, url: URL): boolean =>
  url.pathname === mcpPath &&
  request.method === "POST" &&
  request.headers.get("origin") === null &&
  (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/json");

/**
 * Whether a request could be a cross-site forgery (CSRF), on top of
 * Access's SameSite cookie:
 * - a non-GET request whose `Origin` isn't the admin's own (a missing
 *   `Origin` counts as foreign; browsers send it on every non-GET request);
 * - a call to a server function, whatever its method, without the
 *   `x-tsr-serverFn: true` header TanStack's client always sends. A server
 *   function can be a GET, which a link or an image on another site could
 *   otherwise run, and a cross-site request can't set that header without a
 *   CORS preflight, which the admin never allows.
 */
const isForgeable = (request: Request): boolean => {
  const url = new URL(request.url);
  if (isMcpRequest(request, url)) {
    return false;
  }
  if (
    url.pathname.startsWith(serverFunctionBase) &&
    request.headers.get("x-tsr-serverfn") !== "true"
  ) {
    return true;
  }
  return (
    !safeMethods.has(request.method) &&
    request.headers.get("origin") !== url.origin
  );
};

const forbidden = (): Response =>
  new Response("Forbidden", {
    status: 403,
    headers: { "cache-control": "no-store" },
  });

/**
 * Wraps the admin's handler so it runs only for a verified staff member,
 * whom it's handed. Fails closed: without the Access settings every request
 * is refused.
 */
export const withAccess =
  (handler: (request: Request, staff: Staff) => Promise<Response>) =>
  async (
    request: Request,
    env: AccessEnv,
    /** Answers a verified request before the handler does, when it returns one. */
    first: () => Response | null = () => null
  ): Promise<Response> => {
    if (isForgeable(request)) {
      return forbidden();
    }
    const devEmail = env.DEV_ACCESS_EMAIL ?? "";
    if (devEmail !== "") {
      // The bypass holds only for requests addressed to this machine. A
      // deployment that has the variable is misconfigured: refuse everything
      // rather than guess which check was meant.
      if (!loopbackHosts.has(new URL(request.url).hostname)) {
        return forbidden();
      }
      return first() ?? (await handler(request, { email: devEmail, sub: "" }));
    }
    const staff = await verifiedStaff(request, env);
    if (staff === null) {
      return forbidden();
    }
    return first() ?? (await handler(request, staff));
  };
