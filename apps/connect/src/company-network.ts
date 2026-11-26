// A shared connection reached through the company network (GRA-2327): a
// system inside the client's own network, such as an ERP with no public
// address. An admin marks the connection so, with the one address it is
// at: an http or https origin, its host and port. Only connect's own
// code sends there, through the deployment's company network; a
// connector's isolate has no binding and its only way out is egress
// (egress.ts), which picks the route by the connection's setting, never
// by the host a connector names. Threat model on GRA-2306, section 7:
//
// - Only an admin sets it, and only on a shared connection: a person's
//   own connection never reaches the company network (oauth.ts,
//   `connectWithKey`). It is sealed with the connection's key, so another
//   address takes the key again (tokens.ts), and audited with the
//   connection's own event (CN3).
// - Every request goes to that address alone: its scheme, host and port
//   are the address's, whatever the request named, and only its path and
//   query are the request's (`outbound`). No redirect is followed, not
//   even a download's: an answer that redirects is the caller's failure
//   (CN6). Plain HTTP is taken here only, where the hop into the network
//   is the client's own; every other connection's requests stay HTTPS
//   (CN7).
// - On-prem (plain workerd), the route is a workerd network of its own,
//   bound as `COMPANY_NETWORK`, that allows only the approved addresses:
//   apart from connect's public-only network, which every other request
//   goes through, and from the network the AI endpoints use (GRA-1481).
//   A name that resolves to an address that isn't approved is refused
//   there (CN5); one the client's DNS points at another approved address
//   reaches that system instead, so an IP address is the safer setting.
//   Hosted, the route is a Workers VPC Service binding for the
//   address, through the client's tunnel (Grasp Link): not built yet
//   (GRA-2315, GRA-2317), so a hosted deployment has none and refuses.

import { identifierMaxLength } from "@grasp-os/shared/identifier";

/**
 * The deployment's way into the company network, or none where it has
 * none: on-prem, one workerd network that allows only the approved
 * addresses. Hosted, GRA-2315 plugs in the Workers VPC Service binding.
 */
export const companyRoute = (env: Env): Fetcher | undefined =>
  env.COMPANY_NETWORK;

/**
 * `value` as an approved address: an http or https origin and nothing
 * else (no path, query, fragment or credentials), as the URL parser
 * writes it, so its port is kept only where it isn't the scheme's own;
 * no longer than an audit event's value holds, as each event of its
 * connection names it.
 */
export const companyAddressOf = (value: string): string | undefined => {
  const url = URL.parse(value);
  return url !== null &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.href === `${url.origin}/` &&
    url.origin.length <= identifierMaxLength
    ? url.origin
    : undefined;
};

/** How a connection's requests leave connect. */
export type Outbound = (request: Request) => Promise<Response>;

/** To the public internet, as every connection's but those below. */
export const publicOutbound: Outbound = async (request) => await fetch(request);

/**
 * How the requests of a connection reached through the company network
 * at `address` leave connect, or of any other (`undefined`): to the
 * public internet as they are, or through the company network to the
 * address alone, with only the request's path and query kept, and no
 * redirect followed. Throws where the deployment has no route.
 */
export const outbound = (env: Env, address: string | undefined): Outbound => {
  if (address === undefined) {
    return publicOutbound;
  }
  return async (request) => {
    const route = companyRoute(env);
    if (route === undefined) {
      throw new Error("This deployment has no route into the company network");
    }
    const { pathname, search } = new URL(request.url);
    const target = new URL(address);
    target.pathname = pathname;
    target.search = search;
    return await route.fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: request.signal,
    });
  };
};
