import {
  egressHeader,
  egressKind,
  egressTooLargeMessage,
  filledHost,
  httpMethods,
  pathMatches,
  redirectHostMatches,
  requestHost,
  routeSchema,
} from "@grasp-os/runtime/connector";
import type { EgressKind, Route } from "@grasp-os/runtime/connector";
import { log } from "@grasp-os/shared/log";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { outbound } from "./company-network.ts";
import { credentialForms, withoutCredential } from "./credential-copies.ts";
import { pauseAsked } from "./pause.ts";

// A native connector's only way out. Connect loads each call's connector
// isolate with this as its `globalOutbound`, so every request the
// connector's code sends, by `fetch` or by following a redirect, arrives
// here. Its props, which only connect sets and the connector can't read,
// hold this call's credential (an access token, or an app's API key) and
// the requests the called action declares
// (threat model R9, Q11, EG1 to EG7). A request goes out only to one of
// the connector's hosts, over HTTPS, as a method and path template the
// action declares, with the connector's credential, method-override and
// path-rewrite headers stripped; anything else is refused before it leaves.
// The call's credential is added only for the hosts the connector says it
// goes to (`credentialHosts`), so a connector that lists a host of its own
// choosing (one written by a client's agent, or generated from a spec naming
// a second server) can reach it but never hand it the credential (GN2). A
// host filled per connection (`{company}.example.com`) is named by the
// connector's code as declared and filled here alone, from the values the
// connection signed in with (GRA-2350). Answers reach the connector
// without cookies and with any copy of the credential in their headers
// replaced (`answerHeaders`), so a session a vendor hands out, or a
// credential it echoes in a header, never reaches connector code.
// Redirects aren't followed, except one from a route that names the hosts
// it may lead to (a download), which the handler follows itself,
// once, without the token or anything of the connector's request. A
// response is cut off once its bytes pass a size limit. Raw sockets are
// refused. What keeps an allowed name that resolves to a private address
// from being reached (R9) is the network the request goes out through:
// Cloudflare's egress, which doesn't route a Worker's requests to private,
// loopback or metadata addresses, and on-prem connect's public-only
// workerd network (GRA-1481). `global_fetch_strictly_public` isn't it: it
// only sends requests for the Worker's own zone through the front door.
//
// A shared connection an admin marked as reached through the company
// network (company-network.ts, GRA-2327) is the one exception to where a
// request goes, chosen by connect's props, never by the connector: its
// connector has one host, and every request for it goes through the
// company network to the connection's one address, scheme, host and port
// the address's own, path and query the request's. No redirect is
// followed there, not a download's either. Plain HTTP goes only there:
// the connector's own request is HTTPS to its host, as for any other.
//
// What the allowlist doesn't constrain: the query string and the body of
// an allowed request are the connector's own (threat model EG3). Where a
// provider can't name a call's resource in the path (Google Drive), the
// connector's own code holds the call to it.
//
// A provider's 429 goes back to the connector as it is. Whether its call
// did nothing (`notPerformedMetaKey`) is the connector's to say: this
// handler sees one request at a time, can't tell whether an earlier
// request of the same call already wrote, and can't cheaply tell connect's
// side of the call. But a rate limit is the account's, not the call's: the
// handler pauses the connection for as long as the provider asks
// (`pauseAsked`), on the row every call reads its credential from, so
// every caller waits with it instead of each finding out on its own. The
// answer passed on says how long the pause has left, in `retry-after`.
// Calls already past the credential read still go out; their provider
// refuses them as it refused this one.

/**
 * Largest provider response a connector may read, in bytes: room for the
 * 4 MiB a tool reads (`checkReadable` in runtime/connector).
 */
export const maxEgressResponseBytes = 10 * 1024 * 1024;

/** The status a refused request gets: it never reached the provider. */
const egressRefusedStatus = 403;

/** The status a response gets when it redirected or couldn't be reached. */
const egressFailedStatus = 502;

/** The handler's own answers, passed on as they are (no provider's is). */
const ownAnswers = new WeakSet<Response>();

/**
 * The handler's own answer, marked as such (`egressHeader`), so a
 * connector can tell it from the provider's. The header is dropped from
 * every provider response, so a provider can't pass one off.
 */
const egressAnswer = (
  kind: EgressKind,
  body: string | null = null
): Response => {
  const answer = new Response(body, {
    status:
      kind === egressKind.refused ? egressRefusedStatus : egressFailedStatus,
    headers: { [egressHeader]: kind },
  });
  ownAnswers.add(answer);
  return answer;
};

/**
 * Request headers the connector can't send: credentials (the token is
 * connect's to add); method overrides, which some providers (Google)
 * honour on a POST, turning it into a method the action doesn't declare
 * (Q11); path rewrites, which some servers and proxies (IIS) honour,
 * turning it into a path the action doesn't declare; and hop-by-hop
 * headers that could change the connection itself.
 */
const connectorHeadersRefused = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "x-original-url",
  "x-rewrite-url",
  "upgrade",
  "connection",
  "te",
];

/**
 * Response headers never passed on: cookies, which may hold a session
 * worth as much as the credential, and those that no longer hold for the
 * body as passed on.
 */
const responseHeadersDropped = new Set([
  "set-cookie",
  "set-cookie2",
  "content-encoding",
  "content-length",
  egressHeader,
]);

const egressPropsSchema = z.strictObject({
  /** Which connector, for the log: its name and version. */
  connector: z.string().min(1),
  /** The connection the call is on, which a rate limit pauses. */
  connectionId: z.string().min(1),
  /** Which call, for the log: its capability's ID. */
  callId: z.string().min(1),
  /** The connector's hosts, as declared: templates unfilled. */
  hosts: z.array(z.string().min(1)).min(1),
  /** Those of `hosts` the credential goes to. */
  credentialHosts: z.array(z.string().min(1)).min(1),
  /** The host the connection signed in with for each host template. */
  connectionHosts: z.record(z.string(), z.string()),
  /** The requests the called action declares. */
  routes: z.array(routeSchema),
  /**
   * Path parameters bound to one value: the action's resource property, to
   * the resource the call's capability names.
   */
  values: z.record(z.string(), z.string()),
  /**
   * The connection's credential, for this call only: its access token as
   * a bearer token, or an app's API key in the header its record names.
   */
  credential: z.strictObject({
    header: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    value: z.string().min(1),
    /** The token or key itself, as the vendor issued it. */
    secret: z.string().min(1),
  }),
  /**
   * For a shared connection reached through the company network, the one
   * address its requests go to, as an origin (company-network.ts).
   */
  companyNetwork: z.string().min(1).optional(),
  /** When this call's egress closes, in ms since the epoch. */
  expiresAt: z.number().int(),
});
export type EgressProps = z.infer<typeof egressPropsSchema>;

const knownMethods: ReadonlySet<string> = new Set(httpMethods);

/**
 * The connector's host `url` is for, as declared: one it lists, or a
 * template by its stand-in (`requestHost`).
 */
const declaredHost = (hosts: readonly string[], url: URL): string | undefined =>
  hosts.find((declared) => requestHost(declared) === url.hostname);

/**
 * Refuses a request, and logs it by the connector's own host and a known
 * method only: a host or method the connector's code made up could carry
 * data out into the logs.
 */
const refuse = (
  call: { connector: string; callId?: string; hosts: readonly string[] },
  reason: string,
  url: URL,
  method: string
): Response => {
  log.warn("egress.refused", {
    connector: call.connector,
    callId: call.callId,
    reason,
    host: declaredHost(call.hosts, url) ?? "other",
    method: knownMethods.has(method) ? method : "other",
  });
  return egressAnswer(
    egressKind.refused,
    "Refused by connect's egress allowlist"
  );
};

/** The route the request is for, on `host` as declared, if the call declares it. */
const routeFor = (
  { routes, values }: Pick<EgressProps, "routes" | "values">,
  method: string,
  host: string,
  url: URL
): Route | undefined =>
  routes.find(
    (route) =>
      route.method === method &&
      route.host === host &&
      pathMatches(route.path, url.pathname, values)
  );

/** Redirects a route's `redirects` hosts may be followed for. */
const followedStatuses: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/**
 * Where a redirect from `route` leads, if the route follows it there:
 * HTTPS to one of its redirect hosts, on its own port, without credentials
 * in the URL.
 */
const redirectTarget = (
  route: Route,
  from: URL,
  response: Response
): URL | undefined => {
  const location = response.headers.get("location");
  if (
    route.redirects === undefined ||
    location === null ||
    !followedStatuses.has(response.status)
  ) {
    return undefined;
  }
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return undefined;
  }
  const allowed =
    target.protocol === "https:" &&
    target.username === "" &&
    target.password === "" &&
    target.port === "" &&
    route.redirects.some((pattern) =>
      redirectHostMatches(pattern, target.hostname)
    );
  return allowed ? target : undefined;
};

/**
 * The file a download's redirect leads to, fetched from its storage host
 * with nothing of the connector's request, or a failure if it can't be.
 * The host may name any tenant a route's pattern matches: it is logged as
 * the redirect it was, not by name.
 */
const download = async (
  { connector, callId, expiresAt }: EgressProps,
  route: Route,
  target: URL
): Promise<Response> => {
  const logged = { connector, callId, host: "redirect", method: "GET" };
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(expiresAt - Date.now(), 1)),
    });
    log.info("egress.request", {
      ...logged,
      route: route.path,
      status: response.status,
    });
    return response;
  } catch {
    log.warn("egress.failed", { ...logged, route: route.path });
    return egressAnswer(egressKind.failed);
  }
};

/**
 * A route's answer, through its download redirect if it has one: the file
 * the redirect leads to, or the answer as it came (a redirect anywhere
 * else is refused after this, as any other is).
 */
const throughDownload = async (
  call: EgressProps,
  route: Route,
  from: URL,
  response: Response
): Promise<Response> => {
  const target = redirectTarget(route, from, response);
  if (target === undefined) {
    return response;
  }
  await response.body?.cancel();
  return await download(call, route, target);
};

/**
 * An answer's headers as the connector gets them: without cookies or
 * what no longer holds for the body, and with every exact copy of the
 * credential, as sent or bare, replaced. A vendor that echoes the
 * request's headers (an error that quotes them) can't hand the connector
 * the credential to send on to a host that doesn't take it. Its body
 * goes as it came: that a vendor encodes it some other way, or echoes it
 * in a body, is the connector's review to catch.
 */
const answerHeaders = (
  response: Response,
  { value, secret }: EgressProps["credential"]
): Headers => {
  const forms = credentialForms([value, secret]);
  const headers = new Headers();
  for (const [name, sent] of response.headers) {
    if (!responseHeadersDropped.has(name)) {
      headers.append(name, withoutCredential(sent, forms));
    }
  }
  return headers;
};

/**
 * The response with its body cut off once its bytes pass the size limit:
 * the connector's read fails there, and nothing past it is held in memory.
 * The bytes are counted as they arrive (decoded), never taken from what
 * `content-length` claims. A rate limit's answer says in `retry-after`
 * how long its connection's pause has left (`pausedSeconds`).
 */
const capped = (
  response: Response,
  headers: Headers,
  pausedSeconds?: number
): Response => {
  if (pausedSeconds !== undefined) {
    headers.set("retry-after", String(pausedSeconds));
  }
  const { body, status, statusText } = response;
  if (body === null) {
    return new Response(null, { status, statusText, headers });
  }
  const reader = body.getReader();
  let bytes = 0;
  const limited = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel();
        controller.error(new TypeError("The response isn't a byte stream"));
        return;
      }
      bytes += value.byteLength;
      if (bytes > maxEgressResponseBytes) {
        await reader.cancel();
        controller.error(new Error(egressTooLargeMessage));
        return;
      }
      controller.enqueue(value);
    },
    cancel: async (reason) => {
      await reader.cancel(reason);
    },
  });
  return new Response(limited, { status, statusText, headers });
};

/**
 * The connector's host a request's URL names, and the URL it goes to on
 * this connection: exactly one of the connector's hosts, over HTTPS on
 * its own port, without credentials in the URL; a template filled with
 * the host the connection signed in with, checked against it again.
 * Through the company network, its only one. None for any other.
 */
const reachedHost = (
  { hosts, connectionHosts, companyNetwork }: EgressProps,
  url: URL
): { declared: string; target: URL } | undefined => {
  const declared = declaredHost(hosts, url);
  const host =
    declared === undefined ? undefined : filledHost(declared, connectionHosts);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    declared === undefined ||
    host === undefined ||
    (companyNetwork !== undefined && hosts.length !== 1)
  ) {
    return undefined;
  }
  const target = new URL(url);
  target.hostname = host;
  return { declared, target };
};

/**
 * The egress handler. Reached only as a connector isolate's
 * `globalOutbound`, with props connect sets for one call; without them
 * (another Worker naming this entrypoint), nothing goes out.
 */
export class ConnectorEgress extends WorkerEntrypoint<Env, EgressProps> {
  override async fetch(request: Request): Promise<Response> {
    const props = egressPropsSchema.safeParse(this.ctx.props);
    // A Request's URL is always absolute and parsed.
    const url = new URL(request.url);
    const { method } = request;
    if (!props.success) {
      return refuse(
        { connector: "unknown", hosts: [] },
        "no_call",
        url,
        method
      );
    }
    const call = props.data;
    const {
      connector,
      callId,
      credentialHosts,
      credential,
      companyNetwork,
      expiresAt,
    } = call;
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      return refuse(call, "expired", url, method);
    }
    const reached = reachedHost(call, url);
    if (reached === undefined) {
      return refuse(call, "host", url, method);
    }
    const { declared, target } = reached;
    const route = routeFor(call, method, declared, url);
    if (route === undefined) {
      return refuse(call, "route", url, method);
    }
    const headers = new Headers(request.headers);
    // The credential's own header too: the connector can't send another
    // key there, or a second copy that a provider might read first.
    for (const name of [...connectorHeadersRefused, credential.header]) {
      headers.delete(name);
    }
    if (credentialHosts.includes(declared)) {
      headers.set(credential.header, credential.value);
    }
    let response: Response;
    try {
      response = await outbound(
        this.env,
        companyNetwork
      )(
        new Request(target, {
          method,
          headers,
          body: request.body,
          // A redirect could carry the token to another host: never follow.
          redirect: "manual",
          signal: AbortSignal.timeout(remainingMs),
        })
      );
    } catch {
      log.warn("egress.failed", {
        connector,
        callId,
        host: declared,
        method,
        route: route.path,
      });
      return egressAnswer(egressKind.failed);
    }
    // Hosts, methods, declared paths and statuses only: never the path as
    // sent, the query, headers or bodies (R17, EG7).
    log.info("egress.request", {
      connector,
      callId,
      host: declared,
      method,
      route: route.path,
      status: response.status,
    });
    // A download: the provider sends the file's pre-authenticated URL on
    // its storage host. It is fetched here, once, with nothing of the
    // connector's request (the token least of all: that URL carries its
    // own authority, and isn't the token's audience), and the connector
    // gets only its answer, never the URL. A second redirect is refused
    // below, as any other is.
    if (companyNetwork === undefined) {
      response = await throughDownload(call, route, target, response);
    }
    if (ownAnswers.has(response)) {
      return response;
    }
    // 304 Not Modified goes nowhere; every other 3xx would.
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.status !== 304
    ) {
      await response.body?.cancel();
      log.warn("egress.refused", {
        connector,
        callId,
        reason: "redirect",
        host: declared,
        method,
      });
      return egressAnswer(egressKind.failed);
    }
    // The provider's answer, or its storage host's for a download.
    const pausedSeconds = await pauseAsked(
      this.env.DB,
      call.connectionId,
      response,
      { connector, callId }
    );
    return capped(response, answerHeaders(response, credential), pausedSeconds);
  }

  /** Raw TCP (`cloudflare:sockets`) never leaves: only HTTPS requests. */
  override connect(): never {
    const props = egressPropsSchema.safeParse(this.ctx.props);
    log.warn("egress.refused", {
      connector: props.data?.connector ?? "unknown",
      callId: props.data?.callId,
      reason: "socket",
    });
    throw new Error("Refused by connect's egress allowlist");
  }
}
