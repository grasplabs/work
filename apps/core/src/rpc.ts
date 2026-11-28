import {
  authErrors,
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
import { checkedInCall } from "./call-context.ts";
import { workspace } from "./durable-objects.ts";
import { errorResponse } from "./errors.ts";
import { connectionSession } from "./guest-access.ts";
import { staffEndsAt } from "./onboarding/gate.ts";
import { recheckFrameSchema } from "./person-connections.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import {
  coreRpcAccounting,
  CoreRpcTarget,
  isolateRpcHeld,
  signedOutRpcAccounting,
} from "./rpc-target.ts";
import {
  coalesced,
  recheckedEvery,
  sessionRecheckMs,
} from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
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

/**
 * The close code a connection gets when its session couldn't be read as a
 * call answered (`verify`): the page connects again, and never makes the
 * call twice.
 */
export const sessionUnverifiedCloseCode = 4503;

/** The close code that asks the page to connect again at once. */
export const reconnectCloseCode = 1012;

/**
 * Whether `error` is the platform's, or wraps it (a query's error names
 * what it failed on as its `cause`): the invocation made all the
 * subrequests it may.
 */
const outOfSubrequests = (error: unknown, depth = 0): boolean =>
  error instanceof Error &&
  depth < 5 &&
  (/too many subrequests/iu.test(error.message) ||
    outOfSubrequests(error.cause, depth + 1));

/** The most tellings a connection's socket holds for it: a few, each a few characters. */
const maxQueuedRechecks = 4096;

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
 * staff session's access ending first (the admin's window, or 7 days after
 * Grasp's go for the onboarding scope, gate.ts `staffEndsAt`).
 */
const endsAt = async (
  env: Env,
  person: Identity,
  expiresAt: Date
): Promise<number> => {
  const staffEnds = person.staff ? await staffEndsAt(env) : undefined;
  return staffEnds === undefined || Number.isNaN(staffEnds)
    ? expiresAt.getTime()
    : Math.min(staffEnds, expiresAt.getTime());
};

/** The longest a timer waits in one go (2^31 - 1 ms, about 24.8 days). */
const longestTimerMs = 2_147_483_647;

/**
 * Calls `then` at `at`, however far off: a timer past the longest one
 * waits as long as it may, then again.
 */
const atTime = (at: number, then: () => void): { stop: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const left = at - Date.now();
    timer =
      left > longestTimerMs
        ? setTimeout(arm, longestTimerMs)
        : setTimeout(then, Math.max(0, left));
  };
  arm();
  return {
    stop: () => {
      clearTimeout(timer);
    },
  };
};

/** The pauses before trying to open a connection's socket to the person's object again. */
const personSocketRetryMs = [1000, 2000, 5000, 15_000, 30_000] as const;

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
  /**
   * Reads the session again, told to (person-connections.ts): closes the
   * connection if it ended. Tellings that come together share readings
   * (`coalesced`), so a person whose many sessions end at once costs each
   * of their connections two readings at most, not one per session ended.
   */
  const readNow = coalesced(async (): Promise<void> => {
    // Closed meanwhile (a reading queued behind the one that closed it):
    // nobody is left to read for.
    if (!openHere()) {
      return;
    }
    check.forget();
    try {
      await check();
    } catch {
      // An ended session has closed the connection; a reading that failed
      // is made again at the next call or push.
    }
  });
  /**
   * Checks the session again as a call answers (call-context.ts): a call
   * that ran past its reading's window never answers someone whose session
   * ended meanwhile. Only its answer is withheld: what it wrote has
   * committed. A reading that can't be made then (the database away
   * a moment) closes the connection as unverified, and the answer goes
   * nowhere: the page never makes a call twice that was on its way when
   * the connection dropped (core-connection.ts), so a write the call made
   * is never repeated by a retry, and the page, connected again, reads what
   * it wrote. Answering it an error instead would invite that retry.
   */
  const verify = async (): Promise<void> => {
    try {
      await check();
    } catch (error) {
      if (!isExpectedError(error) && openHere()) {
        server.close(sessionUnverifiedCloseCode, "Session unverified");
      }
      throw error;
    }
  };
  /** The connection's check, which every call it carries checks again as it answers. */
  const callCheck: SessionCheck = Object.assign(
    async (): Promise<Identity> => {
      checkedInCall(verify);
      return await check();
    },
    { forget: check.forget }
  );
  let closed = false;
  // The session's own end, which nothing tells.
  let expiry: { stop: () => void } | undefined;
  void (async () => {
    try {
      const at = await endsAt(env, connectedAs, expiresAt);
      if (!closed) {
        expiry = atTime(at, close);
      }
    } catch (error) {
      // Its calls and pushes still read the session before they go.
      log.warn("rpc.end_unknown", errorFields(error));
    }
  })();
  let following: Disposable | undefined;
  /**
   * Opens the socket to the person's object that tells this connection to
   * read its session again (person-connections.ts), trying again while it
   * can't, for as long as the connection is open.
   */
  const follow = async (): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      if (closed) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one try at a time
        const followed = await followObject({
          open: async () =>
            await workspace(env, personalWorkspaceId(connectedAs.userId)).fetch(
              "https://person/connection",
              {
                headers: { Upgrade: "websocket" },
              }
            ),
          parse: (frame) => recheckFrameSchema.parse(frame),
          deliver: async () => {
            readNow();
            await Promise.resolve();
          },
          maxQueued: maxQueuedRechecks,
          // A telling may have come before the socket was there: whatever
          // was read until now is read again when it is next needed.
          opened: () => {
            check.forget();
          },
          ended: (code) => {
            // Let go of for good: past the object's bound (the person has
            // more connections than it keeps), or a fault. The connection
            // goes on without the telling's speed, its calls and pushes
            // still gated on a fresh reading. Connecting again would only
            // push out the person's next oldest, which would do the same.
            log.warn("rpc.person_socket_ended", { code });
          },
          logged: { purpose: "connection" },
        });
        if (closed) {
          followed[Symbol.dispose]();
          return;
        }
        following = followed;
        return;
      } catch (error) {
        // Meanwhile its calls and pushes still read the session before
        // they go; only the telling's speed is missing.
        log.warn("rpc.person_unfollowed", { attempt, ...errorFields(error) });
      }
      // oxlint-disable-next-line no-await-in-loop -- waiting longer each time
      await scheduler.wait(
        personSocketRetryMs[
          Math.min(attempt, personSocketRetryMs.length - 1)
        ] ?? 0
      );
    }
  };
  void follow();
  // What the connection follows ends with it (drafts-rpc.ts).
  const ending = new AbortController();
  const end = (): void => {
    closed = true;
    expiry?.stop();
    following?.[Symbol.dispose]();
    ending.abort();
  };
  server.addEventListener("close", end);
  server.addEventListener("error", end);
  return new SessionRpc(env, callCheck, sessionId, ending.signal);
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
      // A long-lived connection is one invocation, whose subrequests run
      // out at last (core's limit, admin's upload.ts `workerLimits`):
      // every call after would fail. The connection closes for the page
      // to connect again, a new invocation with its own.
      if (outOfSubrequests(error) && open) {
        server.close(reconnectCloseCode, "Connect again");
      }
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
