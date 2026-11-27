import {
  authErrors,
  internalErrors,
  isExpectedError,
  requestErrors,
  toOpaqueError,
} from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { pageLimits } from "@grasp-os/shared/pages";
import type { CoreApi, Identity, SignInOption } from "@grasp-os/shared/rpc";
import { accountedTransport } from "@grasp-os/shared/rpc-accounting";
import type { RpcAccountingLimits } from "@grasp-os/shared/rpc-accounting";
import { RpcSession, WebSocketTransport } from "capnweb";

import { oidcProviders, providerIds, signInConfig } from "./auth/config.ts";
import { workspace } from "./durable-objects.ts";
import { errorResponse } from "./errors.ts";
import { connectionSession } from "./guest-access.ts";
import { recheckFrameSchema } from "./person-connections.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import {
  coreRpcAccounting,
  CoreRpcTarget,
  isolateRpcHeld,
  signedOutRpcAccounting,
} from "./rpc-target.ts";
import { recheckedEvery, sessionRecheckMs } from "./session-check.ts";
import { SessionRpc } from "./session-rpc.ts";
import { followObject } from "./upstream.ts";

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
        staff: providerId === providerIds.staff,
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
  /** When that session ends. */
  expiresAt: Date;
}

/**
 * When a connection's session ends by itself: the session's end, or a
 * staff session's window closing first.
 */
const endsAt = (env: Env, person: Identity, expiresAt: Date): number => {
  const until = person.staff
    ? Date.parse(signInConfig(env)?.staff?.until ?? "")
    : Number.NaN;
  return Number.isNaN(until)
    ? expiresAt.getTime()
    : Math.min(until, expiresAt.getTime());
};

/**
 * The signed-in API of one connection. Its check is the one place that
 * reads who is behind the connection, and it reads only when asked: by a
 * call, or by a push about to reach the page, once the latest reading is
 * older than `sessionRecheckMs`, shared by every call and push meanwhile.
 * An idle connection reads nothing. Once the session no longer holds
 * (revoked, expired, removed from the organization, staff window closed),
 * it refuses and closes the connection. What each call may do (its role,
 * its App) is still checked by the call, against the identity this hands
 * it.
 *
 * Whatever ends the session or changes who they are tells their object
 * (identity-changes.ts), which tells this connection over its socket to
 * the object (person-connections.ts): it reads at once, so a signed-out or
 * removed person's tab closes within about a second, idle or not, and a
 * new role or team holds from the next call. The session's own end needs
 * no telling: a timer closes the connection then. Threat model, and how
 * each is closed:
 *
 * - A telling lost on its way (the object out of reach, the writer gone
 *   after its commit): nothing more reaches the page, call or push,
 *   without a reading at most `sessionRecheckMs` old, as before tellings.
 * - A telling sent before the connection's socket to the object opened (a
 *   revocation just after the upgrade read the session), or while it was
 *   down: every reading taken before the socket opened (again) is dropped
 *   then, so the next call or push reads anew.
 * - The database away for a moment: the reading fails, which refuses the
 *   call or holds the push, and is read again at the next; it never
 *   counts as signed out, and never lets anything through unread.
 * - A telling forged, late or twice: it only makes the connection read;
 *   its own session decides.
 */
const sessionApi = (
  { env, headers, connectedAs, sessionId, expiresAt }: ConnectionSession,
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
  const check = recheckedEvery(
    sessionRecheckMs,
    async (): Promise<Identity> => {
      // A guest's too: each namespace answers them as nobody but for
      // what guest-access.ts opens to them (session-rpc.ts).
      const signedIn = await connectionSession(env, headers);
      const identity = signedIn?.person;
      if (identity?.userId !== connectedAs.userId) {
        // After the refusal is on its way to the client.
        setTimeout(close, 0);
        throw authErrors.create("auth.unauthenticated");
      }
      return identity;
    }
  );
  /** Reads the session now: told to, or closes the connection if it ended. */
  const readNow = async (): Promise<void> => {
    check.forget();
    try {
      await check();
    } catch {
      // An ended session has closed the connection; a reading that failed
      // is made again at the next call or push.
    }
  };
  // The session's own end, which nothing tells.
  const expiry = setTimeout(
    close,
    endsAt(env, connectedAs, expiresAt) - Date.now()
  );
  let closed = false;
  let following: Disposable | undefined;
  const follow = async (): Promise<void> => {
    try {
      const followed = await followObject({
        open: async () =>
          await workspace(env, personalWorkspaceId(connectedAs.userId)).fetch(
            `https://person/connection?${new URLSearchParams({ person: connectedAs.userId }).toString()}`,
            { headers: { Upgrade: "websocket" } }
          ),
        deliver: async (frame) => {
          if (recheckFrameSchema.safeParse(frame).success) {
            await readNow();
          }
        },
        // A telling may have come before the socket was there: whatever was
        // read until now is read again when it is next needed.
        opened: () => {
          check.forget();
        },
        ended: () => {
          // Let go of past the object's bound: this connection reads its
          // session as often as any, without the telling's speed.
        },
        refused: () => internalErrors.create("internal.unexpected"),
        logged: { purpose: "connection" },
      });
      if (closed) {
        followed[Symbol.dispose]();
        return;
      }
      following = followed;
    } catch (error) {
      // Without it the connection still reads its session before every
      // call and push; only the telling's speed is lost.
      log.warn("rpc.person_unfollowed", errorFields(error));
    }
  };
  void follow();
  const end = (): void => {
    closed = true;
    clearTimeout(expiry);
    following?.[Symbol.dispose]();
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
  const signedIn = await connectionSession(env, headers);
  const session = signedIn
    ? sessionApi(
        {
          env,
          headers,
          connectedAs: signedIn.person,
          sessionId: signedIn.sessionId,
          expiresAt: signedIn.expiresAt,
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
 * Serves `api` over the accepted socket `server` with Cap'n Web, for a
 * browser's connection (`/rpc`). What a browser sends is untrusted, a page's calls
 * among it, and it may be reachable before anyone signed in: bound it
 * before Cap'n Web expands it. The accountant wraps the transport: it
 * refuses a message longer than `browserMessageSize` or of too many nodes
 * before parsing it, parses it once and hands the value to Cap'n Web
 * (which then checks no size of its own, only depth and digits), and ends
 * the connection once what the messages copy or hold would outgrow one
 * message's budget or the connection's (`accounting`). What a value held
 * by a target gets is bounded again where it lands (rpc-target.ts), and a
 * page's call to its bytes (pages-rpc.ts). Every connection of the
 * isolate together holds no more than `isolateRpcHeld`.
 */
export const serveRpc = (
  server: WebSocket,
  api: InstanceType<typeof CoreRpcTarget>,
  accounting: RpcAccountingLimits,
  requestId: string
): void => {
  // Cap'n Web also passes the reason a session ended through onSendError.
  // A closed socket is how sessions normally end, so that isn't logged.
  let open = true;
  server.addEventListener("close", () => {
    open = false;
  });
  const transport = accountedTransport(
    new WebSocketTransport(server),
    accounting,
    () => requestErrors.create("request.too_expensive"),
    isolateRpcHeld
  );
  // The session runs itself from its read loop; the socket and the
  // transport keep it reachable for as long as the connection is open.
  const connection = new RpcSession(transport, api, {
    limits: {
      maxDepth: pageLimits.rpc.maxDepth,
      maxBigIntDigits: pageLimits.rpc.maxBigIntDigits,
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
};

/**
 * Opens a Cap'n Web session over WebSocket. The session lives in this Worker
 * invocation for as long as the socket is open; hibernation applies once RPC
 * is routed to a Durable Object.
 *
 * The session cookie is checked when the connection opens, and again
 * before a call or a push once that reading is a few seconds old, or at
 * once when the person's object says it may have ended (`sessionApi`).
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
  server.accept();
  // A connection that isn't signed in holds little; every connection of the
  // isolate together holds no more than `isolateRpcHeld`.
  const { api, signedIn } = await browserConnection(env, headers, server);
  serveRpc(
    server,
    api,
    signedIn ? coreRpcAccounting : signedOutRpcAccounting,
    requestId
  );
  return new Response(null, { status: 101, webSocket: client });
};
