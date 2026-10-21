import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { requestErrors } from "@grasp-os/shared/errors";
import type { ErrorPayload } from "@grasp-os/shared/errors";
import { guestApiPath } from "@grasp-os/shared/guests";
import {
  readAtMost,
  requestIdHeader,
  strictTransportSecurity,
} from "@grasp-os/shared/http";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  mailFromHeader,
  mailIngressHeaders,
  mailIngressMaxBytes,
  mailIngressPath,
  mailRejectedStatus,
  mailSentAtHeader,
  mailSha256Header,
  mailSignatureHeader,
  mailSizeHeader,
  mailToHeader,
  signMail,
} from "@grasp-os/shared/mail-ingress";
import {
  deriveRouterSecret,
  routerHostKey,
  routerClientIpHeader,
  routerHostSchema,
  routerSecretHeader,
} from "@grasp-os/shared/router";

import { clientAddress } from "./client-address.ts";
import { routeCache } from "./route-cache.ts";

/** Where one hostname goes, and the secret its core expects. */
interface Route {
  origin: string;
  secret: string;
}

/**
 * How long this isolate trusts what it read from the hostname map (and
 * Secrets Store), found or not. A new or changed host, or a raised
 * generation, takes effect within this cache plus KV's propagation (about
 * 60 s), so while rotating, core must accept the previous secret for at
 * least 2 minutes.
 */
const routeCacheMs = 30_000;

/** Hostnames remembered per isolate. */
const maxCachedHosts = 1000;

const routes = routeCache<Route | null>(maxCachedHosts, routeCacheMs);

/**
 * Reads a host's entry from the map and derives its secret. An entry that
 * doesn't parse, or names anything but an https `*.workers.dev` origin,
 * routes nowhere. Throws when the router key can't be read, so nothing is
 * forwarded (and nothing cached) without the right secret.
 */
const loadRoute = async (host: string, env: Env): Promise<Route | null> => {
  const stored = await env.HOSTS.get(host, "json");
  if (stored === null) {
    return null;
  }
  const parsed = routerHostSchema.safeParse(stored);
  if (!parsed.success) {
    log.error("router.host_refused", { host });
    return null;
  }
  const { clientId, coreUrl, generation } = parsed.data;
  const routerKey = await env.ROUTER_KEY.get();
  return {
    origin: new URL(coreUrl).origin,
    secret: await deriveRouterSecret(routerKey, clientId, generation),
  };
};

const routeFor = async (host: string, env: Env): Promise<Route | null> => {
  const cached = routes.get(host, Date.now());
  if (cached !== undefined) {
    return cached.value;
  }
  const route = await loadRoute(host, env);
  routes.set(host, route, Date.now());
  return route;
};

/** The most of core's reason for a bounce the sender is told. */
const maxBounceReason = 500;

/**
 * The reason the sender reads for a message core bounced: core's own, as
 * its answer gives it, or a plain one when that isn't a short string.
 */
const bounceReason = (answer: unknown): string => {
  const reason: unknown =
    typeof answer === "object" && answer !== null
      ? Reflect.get(answer, "reason")
      : undefined;
  return typeof reason === "string" &&
    reason !== "" &&
    reason.length <= maxBounceReason
    ? reason
    : "The message can't be delivered.";
};

/** Core's sign-in routes (Better Auth, core's `authBasePath`). */
const authBasePath = "/api/auth";

/**
 * The limits' window, as `AUTH_RATE_LIMIT`, `GUEST_RATE_LIMIT` and
 * `INTERVIEW_RATE_LIMIT` all have it in wrangler.jsonc.
 */
const limitPeriodS = 60;

/**
 * Whether a request is within `limiter`'s limit for its hostname and
 * client address: core's sign-in routes (Better Auth's own limiter is off
 * in core, as behind the router every request comes from the router's
 * address), and the endpoints of a guest chat and of an interview link,
 * which have no session to limit by. Keyed by the client's IPv4 address or IPv6 /64 (`clientAddress`),
 * so rotating through a /64 buys no fresh budget, and by hostname too, so
 * one office behind one address counts separately for each client. When
 * the limiter itself fails, the request goes through (and is logged):
 * sign-in and guests stay up.
 */
const withinLimit = async (
  limiter: RateLimit,
  request: Request,
  host: string
): Promise<boolean> => {
  const ip = clientAddress(
    request.headers.get("cf-connecting-ip") ?? "unknown"
  );
  try {
    const { success } = await limiter.limit({ key: `${host}|${ip}` });
    return success;
  } catch (error) {
    log.error("router.rate_limit_failed", { host, ...errorFields(error) });
    return true;
  }
};

/** Core's sign-out route, which the limit leaves alone. */
const signOutPath = `${authBasePath}/sign-out`;

/**
 * The router's own 429, with the headers core puts on every response it
 * makes (a request ID, `nosniff`, HSTS on https), since it answers in
 * core's place. The request ID is logged with the refusal.
 */
const rateLimited = (url: URL, host: string): Response => {
  const requestId = crypto.randomUUID();
  const { code, message } = requestErrors.create("request.rate_limited");
  const headers = new Headers({
    "retry-after": String(limitPeriodS),
    [requestIdHeader]: requestId,
    "x-content-type-options": "nosniff",
  });
  if (url.protocol === "https:") {
    headers.set("strict-transport-security", strictTransportSecurity);
  }
  log.warn("router.rate_limited", { host, requestId });
  return Response.json(
    { code, message, details: { requestId } } satisfies ErrorPayload,
    { status: 429, headers }
  );
};

/**
 * Forwards each request on a client's hostname to that client's core, with
 * the router secret so a client's workers.dev address is no back door.
 * Pass-through only: the method, path, query, headers and body go as they
 * came (but for Host, the router secret and the client-IP header),
 * WebSocket upgrades included, and core's response comes back as it
 * is, redirects included. Logs no headers, URLs or bodies.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = routerHostKey(url.hostname);

    let route: Route | null;
    try {
      route = await routeFor(host, env);
    } catch (error) {
      log.error("router.route_failed", { host, ...errorFields(error) });
      return new Response("Service unavailable", { status: 503 });
    }
    if (route === null) {
      return new Response("Not found", { status: 404 });
    }

    const { pathname } = url;
    // Mail reaches core only through `email` below, signed: never from
    // the public, whatever it sends.
    if (pathname === mailIngressPath) {
      return new Response("Not found", { status: 404 });
    }
    const isAuth =
      pathname === authBasePath || pathname.startsWith(`${authBasePath}/`);
    // Signing out needs no protection from guessing, and refusing it would
    // leave the person signed in.
    const isLimited = isAuth && pathname !== signOutPath;
    if (isLimited && !(await withinLimit(env.AUTH_RATE_LIMIT, request, host))) {
      return rateLimited(url, host);
    }
    // A guest chat's endpoint (core's src/guests.ts), which anyone with a
    // link, or without one, can reach.
    if (
      pathname === guestApiPath &&
      !(await withinLimit(env.GUEST_RATE_LIMIT, request, host))
    ) {
      return rateLimited(url, host);
    }
    // An interview link's endpoint (core's src/onboarding/links.ts), the
    // same; core counts per link too.
    if (
      pathname === interviewApiPath &&
      !(await withinLimit(env.INTERVIEW_RATE_LIMIT, request, host))
    ) {
      return rateLimited(url, host);
    }

    // Any copy the caller sent is replaced (threat model RT3): the secret
    // comes only from the map entry for the hostname the request came to.
    // The client's IP comes only from Cloudflare's `cf-connecting-ip`, which
    // the edge sets itself. The client's Host goes too: the target's host
    // comes from the URL alone.
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set(routerSecretHeader, route.secret);
    headers.delete(routerClientIpHeader);
    for (const name of mailIngressHeaders) {
      headers.delete(name);
    }
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp !== null) {
      headers.set(routerClientIpHeader, clientIp);
    }
    try {
      return await fetch(`${route.origin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });
    } catch (error) {
      // The error's kind only: a failed fetch's message or stack can carry
      // the target URL, and with it an OAuth callback's code and state.
      log.error("router.forward_failed", {
        host,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return new Response("Bad gateway", { status: 502 });
    }
  },

  /**
   * Sorts the mail Email Routing hands the router (one catch-all for every
   * client's domain) to the client whose hostname is the recipient's
   * domain, and to no other: unknown, the message bounces. Passes the
   * raw message on to that client's core, signed for exactly its
   * recipient, sender and bytes (@grasp-os/shared/mail-ingress), and
   * keeps nothing of it. Core's answer is the message's: taken, bounced
   * with core's reason, or anything else failed for now (thrown), so
   * Email Routing tells the sender to try again. Logs the domain, the
   * message's hash and size, never an address or what it says.
   */
  async email(message, env) {
    const at = message.to.lastIndexOf("@");
    const host = routerHostKey(message.to.slice(at + 1));
    // Thrown when the map or the key can't be read: failed for now, never
    // sent anywhere else.
    const route = at > 0 ? await routeFor(host, env) : null;
    if (route === null) {
      log.info("router.mail_unrouted", { host });
      message.setReject("No such address.");
      return;
    }
    const raw =
      message.rawSize > mailIngressMaxBytes
        ? undefined
        : await readAtMost(message.raw, mailIngressMaxBytes);
    if (raw === undefined) {
      log.info("router.mail_too_large", { host, size: message.rawSize });
      message.setReject("The message is too large.");
      return;
    }
    const mail = {
      to: message.to,
      from: message.from,
      sha256: await sha256HexOfBytes(raw),
      size: raw.byteLength,
      sentAt: new Date().toISOString(),
    };
    const response = await fetch(`${route.origin}${mailIngressPath}`, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        [routerSecretHeader]: route.secret,
        [mailToHeader]: mail.to,
        [mailFromHeader]: mail.from,
        [mailSha256Header]: mail.sha256,
        [mailSizeHeader]: String(mail.size),
        [mailSentAtHeader]: mail.sentAt,
        [mailSignatureHeader]: await signMail(route.secret, mail),
      },
      body: raw,
      redirect: "manual",
    });
    const fields = {
      host,
      message: mail.sha256,
      size: mail.size,
      status: response.status,
    };
    if (response.status === mailRejectedStatus) {
      log.info("router.mail_bounced", fields);
      message.setReject(bounceReason(await response.json().catch(() => null)));
      return;
    }
    await response.body?.cancel();
    if (response.status !== 202) {
      log.error("router.mail_failed", fields);
      throw new Error(
        `Core didn't take message ${mail.sha256} (${response.status})`
      );
    }
    log.info("router.mail_delivered", fields);
  },
} satisfies ExportedHandler<Env>;
