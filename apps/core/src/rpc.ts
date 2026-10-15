import {
  authErrors,
  isExpectedError,
  requestErrors,
  toOpaqueError,
} from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import type { CoreApi, Identity, SignInOption } from "@grasp-os/shared/rpc";
import { accountedTransport } from "@grasp-os/shared/rpc-accounting";
import { screenLimits } from "@grasp-os/shared/screens";
import { RpcSession, WebSocketTransport } from "capnweb";

import { oidcProviders, signInConfig } from "./auth/config.ts";
import { identify, signedInSession } from "./auth/identity.ts";
import { errorResponse } from "./errors.ts";
import {
  coreRpcAccounting,
  CoreRpcTarget,
  isolateRpcHeld,
  signedOutRpcAccounting,
} from "./rpc-target.ts";
import { recheckedEvery, sessionRecheckMs } from "./session-check.ts";
import { SessionRpc } from "./session-rpc.ts";

/** What the frontend reaches over `/rpc`, signed in or not. */
export class CoreRpc extends CoreRpcTarget implements CoreApi {
  readonly #options: SignInOption[];
  readonly #session: SessionRpc | undefined;

  constructor(options: SignInOption[], session?: SessionRpc) {
    super();
    this.#options = options;
    this.#session = session;
  }

  // Cap'n Web exposes prototype methods only, so this can't be static.
  // oxlint-disable-next-line class-methods-use-this
  ping(): "pong" {
    return "pong";
  }

  signInOptions(): SignInOption[] {
    return this.#options;
  }

  authenticate(): SessionRpc {
    if (!this.#session) {
      throw authErrors.create("auth.unauthenticated");
    }
    return this.#session;
  }
}

/**
 * Decides what an error looks like to the frontend. Errors from a known
 * family go out as they are (Cap'n Web drops the stack); anything else is
 * replaced, so internals never reach the client.
 */
export const toClientError = (
  error: Error,
  requestId: string
): Error | undefined =>
  isExpectedError(error) ? undefined : toOpaqueError(error, { requestId });

/** The close code a connection gets when its session ends. */
export const sessionEndedCloseCode = 4401;

const signInOptions = (env: Env): SignInOption[] => {
  const config = signInConfig(env);
  return config
    ? oidcProviders(env, config, Date.now()).map(({ providerId, label }) => ({
        providerId,
        label,
      }))
    : [];
};

/**
 * Browsers send cookies with a WebSocket upgrade from any site and apply no
 * CORS to it, so without this check any page could open a signed-in
 * connection in the person's name (cross-site WebSocket hijacking). The
 * `Origin` a browser sends can't be forged by a page, so it must be exactly
 * the deployment's own origin from its config; a missing one is refused too.
 * The request's own URL is no guide: the router forwards it to core's
 * workers.dev address. Without sign-in config (local development) nobody can
 * have a session, and the page's own origin is accepted.
 */
export const isOwnOrigin = (request: Request, env: Env): boolean =>
  request.headers.get("Origin") ===
  (signInConfig(env)?.origin ?? new URL(request.url).origin);

/** Who the connection signed in as, and how to tell they still are. */
interface ConnectionSession {
  env: Env;
  /** Only the cookie of the upgrade request. */
  headers: Headers;
  connectedAs: Identity;
  /** The session the cookie held: the same for as long as the connection is open. */
  sessionId: string;
}

/**
 * The signed-in API of one connection. Its check is the one place that
 * reads who is behind the connection: at most every `sessionRecheckMs`,
 * shared by every call and every push meanwhile, and on a timer as often,
 * so an idle connection doesn't stay open on an ended session either.
 * Once the session no longer holds (revoked, expired, removed from the
 * organization, staff window closed), it refuses and closes the
 * connection. What each call may do (its role, its App) is still checked
 * by the call, against the identity this hands it.
 */
const sessionApi = (
  { env, headers, connectedAs, sessionId }: ConnectionSession,
  server: WebSocket
): SessionRpc => {
  /**
   * Whether the connection is open and belongs to the request running
   * now. A timer runs in the request that set it, but a clock something
   * else drives (a faked one, moved on inside another Durable Object's
   * request) can run it in another's, where workerd refuses even a look
   * at the socket: that request leaves the connection alone.
   */
  const openHere = (): boolean => {
    try {
      return server.readyState === WebSocket.OPEN;
    } catch {
      return false;
    }
  };
  const close = (): void => {
    if (openHere()) {
      server.close(sessionEndedCloseCode, "Session ended");
    }
  };
  let ended = false;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  /**
   * Has the timer read again as the latest reading runs out, whether or
   * not a call asks first: so an ended session closes the connection
   * within one window, used or idle, and a busy connection still reads
   * once a window. The timer goes with the connection.
   */
  const recheckWhenDue = (run: () => Promise<void>): void => {
    clearTimeout(recheck);
    if (!ended) {
      recheck = setTimeout(() => {
        if (!ended && openHere()) {
          void run();
        }
      }, sessionRecheckMs);
    }
  };
  const checkQuietly = async (): Promise<void> => {
    try {
      // oxlint-disable-next-line no-use-before-define -- the check and its timer start each other; this runs only once both exist
      await check();
    } catch {
      // An ended session has closed the connection; a reading that failed
      // is made again at the next tick or call.
    }
  };
  const check = recheckedEvery(
    sessionRecheckMs,
    async (): Promise<Identity> => {
      recheckWhenDue(checkQuietly);
      const identity = await identify(env, headers);
      if (identity?.userId !== connectedAs.userId) {
        // After the refusal is on its way to the client.
        setTimeout(close, 0);
        throw authErrors.create("auth.unauthenticated");
      }
      return identity;
    }
  );
  // The upgrade has just read the session: the next reading is due a
  // window on.
  recheckWhenDue(checkQuietly);
  const end = (): void => {
    ended = true;
    clearTimeout(recheck);
  };
  server.addEventListener("close", end);
  server.addEventListener("error", end);
  return new SessionRpc(env, check, sessionId);
};

/**
 * What a browser's connection over `server` reaches: signed in as the
 * session `headers` carry (only the upgrade request's cookie), if it holds
 * one. Every target the browser can reach from here extends
 * `CoreRpcTarget` (test/rpc-targets.test.ts walks them all).
 */
/** A connection's API, and whether it is signed in. */
const browserConnection = async (
  env: Env,
  headers: Headers,
  server: WebSocket
): Promise<{ api: CoreRpc; signedIn: boolean }> => {
  const signedIn = await signedInSession(env, headers);
  const session = signedIn
    ? sessionApi(
        {
          env,
          headers,
          connectedAs: signedIn.person,
          sessionId: signedIn.sessionId,
        },
        server
      )
    : undefined;
  return {
    api: new CoreRpc(signInOptions(env), session),
    signedIn: session !== undefined,
  };
};

export const browserApi = async (
  env: Env,
  headers: Headers,
  server: WebSocket
): Promise<CoreRpc> => {
  const { api } = await browserConnection(env, headers, server);
  return api;
};

/**
 * Opens a Cap'n Web session over WebSocket. The session lives in this Worker
 * invocation for as long as the socket is open; hibernation applies once RPC
 * is routed to a Durable Object.
 *
 * The session cookie is checked when the connection opens, and again every
 * few seconds for as long as it is open (`sessionApi`).
 */
export const rpcResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    const response = errorResponse(
      426,
      requestErrors.create("request.upgrade_required"),
      requestId
    );
    response.headers.set("Upgrade", "websocket");
    return response;
  }
  if (!isOwnOrigin(request, env)) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }

  const cookie = request.headers.get("Cookie");
  const headers = new Headers(cookie === null ? {} : { cookie });
  const { 0: client, 1: server } = new WebSocketPair();
  // Cap'n Web also passes the reason a session ended through onSendError.
  // A closed socket is how sessions normally end, so that isn't logged.
  let open = true;
  server.addEventListener("close", () => {
    open = false;
  });
  server.accept();

  // What a browser sends is untrusted, a screen's calls among it, and it is
  // reachable signed out: bound it before Cap'n Web expands it. The
  // accountant wraps the transport: it refuses a message longer than
  // `browserMessageSize` or of too many nodes before parsing it, parses it
  // once and hands the value to Cap'n Web (which then checks no size of its
  // own, only depth and digits), and ends the connection once what the
  // messages copy or hold would outgrow one message's budget or the
  // connection's (`coreRpcAccounting`). What a value held by a target gets
  // is bounded again where it lands (rpc-target.ts), and a screen's call to
  // its bytes (screens-rpc.ts).
  // A connection that isn't signed in holds little; every connection of the
  // isolate together holds no more than `isolateRpcHeld`.
  const { api, signedIn } = await browserConnection(env, headers, server);
  const transport = accountedTransport(
    new WebSocketTransport(server),
    signedIn ? coreRpcAccounting : signedOutRpcAccounting,
    () => requestErrors.create("request.too_expensive"),
    isolateRpcHeld
  );
  // The session runs itself from its read loop; the socket and the
  // transport keep it reachable for as long as the connection is open.
  const connection = new RpcSession(transport, api, {
    limits: {
      maxDepth: screenLimits.rpc.maxDepth,
      maxBigIntDigits: screenLimits.rpc.maxBigIntDigits,
    },
    onSendError: (error) => {
      // Every call of the tab goes over this one connection, so each
      // failure gets a request ID of its own for the person to quote, and
      // its log line names the connection's too.
      const failureId = crypto.randomUUID();
      const sent = toClientError(error, failureId);
      if (sent && open) {
        log.error("rpc.failed", {
          requestId: failureId,
          connectionRequestId: requestId,
          ...errorFields(error),
        });
      }
      return sent;
    },
  });
  void connection;
  return new Response(null, { status: 101, webSocket: client });
};
