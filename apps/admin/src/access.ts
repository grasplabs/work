/**
 * The admin's own check of Cloudflare Access (threat model R19, CO1, CO5).
 * Access stands in front of the admin, but the Worker trusts nothing it
 * hasn't verified itself: every request must carry an Access JWT signed by
 * the team's keys, for the admin's application, or it is refused.
 */
import "@tanstack/react-start/server-only";
import { loopbackHosts } from "@grasp-os/shared/router";

import { verifyIssuerJwt } from "./issuer-keys.ts";

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
    // Access signs with RS256, its keys at the team's own address.
    const { payload } = await verifyIssuerJwt(token, {
      issuer,
      audience,
      keysUrl: `${issuer}/cdn-cgi/access/certs`,
    });
    if (typeof payload.email !== "string" || payload.email === "") {
      return null;
    }
    return { email: payload.email, sub: payload.sub ?? "" };
  } catch {
    return null;
  }
};

/**
 * Where TanStack Start serves server functions (its default base). Start
 * guards these against cross-site calls itself (src/start.ts).
 */
const serverFunctionBase = "/_serverFn/";

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
 * Access's SameSite cookie: a non-GET request whose `Origin` isn't the
 * admin's own (a missing `Origin` counts as foreign; browsers send it on
 * every non-GET request), other than an MCP client's call. Server
 * functions are left to Start's own check (src/start.ts), which refuses
 * any call, GET included, a page elsewhere could make.
 */
const isForgeable = (request: Request): boolean => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith(serverFunctionBase) ||
    isMcpRequest(request, url)
  ) {
    return false;
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
