/**
 * Signing in to a core this machine runs, the way a browser does, through
 * the fake IdP (apps/core/test/idp-worker.ts), and opening the person's API
 * over `/rpc`: what the seed does to the local stack (seed/local.ts) and
 * the on-prem smoke run to core on plain workerd (workerd-smoke-sealed.ts).
 * Each request carries `headers` too, such as the router secret a core
 * served without the router asks for.
 */
import { once } from "node:events";

import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";

/** Where core is, where its fake IdP is, and what every request carries. */
export interface CoreSite {
  origin: string;
  idpOrigin: string;
  headers?: Record<string, string>;
}

const sessionCookie = "__Host-grasp.session_token";

/** The `name=value` pairs a response sets, as a `Cookie` header. */
const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

const locationOf = (response: Response, step: string): string => {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(`${step} did not redirect (${response.status})`);
  }
  return location;
};

/**
 * Signs in as `email` the way a browser does, and returns the session
 * cookie's value. Refuses to go on unless core sends the browser to the
 * fake IdP at `idpOrigin`: core does that only for a stack on this machine
 * (`devIdpOrigin` in apps/core/src/auth/config.ts).
 */
export const signInThrough = async (
  { origin, idpOrigin, headers = {} }: CoreSite,
  email: string,
  {
    providerId = "microsoft",
    signal,
  }: {
    /** Grasp's own tenant (`grasp-staff`) for the stack's staff member. */
    providerId?: "microsoft" | "grasp-staff";
    /** Aborts each request of the sign-in, for a caller with a deadline. */
    signal?: AbortSignal;
  } = {}
): Promise<string> => {
  let started: Response;
  try {
    started = await fetch(new URL("/api/auth/sign-in/sso", origin), {
      method: "POST",
      headers: { ...headers, origin, "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        providerId,
        callbackURL: "/",
        errorCallbackURL: "/",
        loginHint: email,
      }),
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    throw new Error(`Nothing answers at ${origin}.`, { cause: error });
  }
  const body: unknown = await started.json();
  if (
    !started.ok ||
    typeof body !== "object" ||
    body === null ||
    !("url" in body) ||
    typeof body.url !== "string"
  ) {
    throw new Error(`Sign-in as ${email} did not start (${started.status})`);
  }
  if (new URL(body.url).origin !== idpOrigin) {
    throw new Error(
      `Core at ${origin} signs people in at ${new URL(body.url).origin}, not the fake IdP at ${idpOrigin}.`
    );
  }
  const atIdp = await fetch(body.url, { redirect: "manual", signal });
  const finished = await fetch(locationOf(atIdp, "The IdP"), {
    redirect: "manual",
    signal,
    headers: { ...headers, cookie: cookiesOf(started) },
  });
  const session = cookiesOf(finished)
    .split("; ")
    .find((pair) => pair.startsWith(`${sessionCookie}=`));
  if (session === undefined) {
    throw new Error(
      `Sign-in as ${email} refused: ${locationOf(finished, "Core")}`
    );
  }
  return decodeURIComponent(session.slice(sessionCookie.length + 1));
};

/** The `Cookie` header of a session. */
export const cookieHeader = (cookie: string): string =>
  `${sessionCookie}=${encodeURIComponent(cookie)}`;

export type Api = ReturnType<RpcStub<CoreApi>["authenticate"]>;

/** Someone signed in, with their API over `/rpc`. */
export interface Session {
  email: string;
  userId: string;
  cookie: string;
  api: Api;
  close: () => void;
}

/** Rejects with why `signal` aborted, once it does. */
export const abortOf = async (signal: AbortSignal): Promise<never> => {
  if (!signal.aborted) {
    await once(signal, "abort");
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Aborted", { cause: signal.reason });
};

/**
 * Signs `email` in at `site` and opens their API. With a `signal`, its
 * requests are aborted and the session is closed once it aborts, so a
 * caller with a deadline is never left waiting on core.
 */
export const openSession = async (
  site: CoreSite,
  email: string,
  { signal }: { signal?: AbortSignal } = {}
): Promise<Session> => {
  const cookie = await signInThrough(site, email, { signal });
  signal?.throwIfAborted();
  const url = new URL("/rpc", site.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Node's WebSocket (undici) takes headers, which a browser's doesn't.
  const socket = new WebSocket(url, {
    headers: {
      ...site.headers,
      origin: site.origin,
      cookie: cookieHeader(cookie),
    },
  });
  const core = newWebSocketRpcSession<CoreApi>(socket);
  const close = (): void => {
    signal?.removeEventListener("abort", close);
    core[Symbol.dispose]();
  };
  signal?.addEventListener("abort", close, { once: true });
  const api = core.authenticate();
  let userId: string;
  try {
    const whoami = api.whoami();
    ({ userId } = await (signal === undefined
      ? whoami
      : Promise.race([whoami, abortOf(signal)])));
  } catch (error) {
    // Nothing returned closes it: close the session here.
    close();
    throw error;
  }
  return { email, userId, cookie, api, close };
};
