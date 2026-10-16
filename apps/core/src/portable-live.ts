// oxlint-disable max-classes-per-file -- a live connection before it authenticates, and the App's live queries it answers once it has
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import {
  portableLivePath,
  tokenExpiredCloseCode,
} from "@grasp-os/shared/portable";
import type {
  PortableLiveApi,
  PortableQueriesApi,
} from "@grasp-os/shared/portable";
import type { Identity } from "@grasp-os/shared/rpc";
import { screenErrors } from "@grasp-os/shared/screens";
import type { QuerySnapshotPush } from "@grasp-os/shared/screens";

import {
  appAfter,
  logRefusedToken,
  recordPortableUse,
} from "./app-function-route.ts";
import { checkAppToken } from "./auth/app-tokens.ts";
import type { TokenCheck } from "./auth/app-tokens.ts";
import { errorResponse } from "./errors.ts";
import { isStub } from "./page-callbacks.ts";
import { QuerySubscriptions, screenReads } from "./query-subscriptions.ts";
import { CoreRpcTarget, coreRpcAccounting } from "./rpc-target.ts";
import { serveRpc, sessionEndedCloseCode } from "./rpc.ts";
import type { RunSubscription } from "./run-subscription.ts";
import { deliveryOpen, requireDelivery } from "./screen-trust.ts";
import { admitted, stillHasRole } from "./screens-rpc.ts";
import { recheckedEvery, sessionRecheckMs } from "./session-check.ts";

// A portable host's live connection (spec 10.7.1, 11): the App's UI
// outside Grasp's shell follows the App's live queries as a screen does,
// over `GET /api/portable/app-live/<app>`, a WebSocket speaking Cap'n
// Web. Browsers can't put `Authorization` on a WebSocket, and a token in
// the URL would end up in logs, so the person's App token
// (auth/app-tokens.ts) comes in the connection's first call
// (`PortableLiveApi.connect`). What it then reaches is the frame's live
// queries: the same `QuerySubscriptions` manager and `screenReads`, with
// no build core approved (as the portable function route: only when the
// App's data is `ordinary`, never once its release is revoked). Threat
// model, and how each is closed:
//
// - A cookie lends its authority: browsers send the person's cookies
//   with any WebSocket upgrade, from any site, with no CORS. Nothing here
//   reads a cookie, and any origin is served: the token alone is the
//   authority, and a site without one reaches nothing. The cookie's
//   `/rpc` reads no token.
// - A connection held open without authenticating: until `connect`
//   answers, nothing but `connect` is reachable; it is answered once per
//   connection; a connection that hasn't connected within
//   `connectWithinMs`, or whose `connect` was refused, is closed. Each is
//   bounded as a signed-in browser connection is (`serveRpc`), and every
//   connection of the isolate together by its shared pool.
// - The token expires mid-subscription: the connection keeps its `exp`,
//   and the host swaps in a newer one before it (`renew`). One past its
//   `exp` unrenewed closes the connection with `tokenExpiredCloseCode`,
//   before anything more is pushed, and no refusal is: an expired
//   credential isn't lost access, so the host asks for a fresh token and
//   follows again, rather than clearing what it shows.
// - Access lost mid-subscription (signed out, session ended or revoked,
//   removed, a role or team lost, the App unshared): the token is checked
//   again (`checkAppToken`: signature, `exp`, its session, the person's
//   access) at most every `sessionRecheckMs`, and on a timer as often, so
//   an idle connection is checked too; every read and push passes the
//   gate of query-subscriptions.ts (role and delivery). A session that
//   ended is pushed as each subscription's last result
//   (`auth.unauthenticated`), and the connection closed after it.
// - Someone else's token: one connection is one person's for its whole
//   life. `renew` with anyone else's is refused `auth.principal_changed`
//   and closes the connection.
// - Another App: the App is named by the path alone, and every token,
//   at `connect` and `renew` alike, must be for exactly it. A request
//   naming another App's reference is refused by the read itself.
// - A stolen token replayed: as on the function route, minutes, one App,
//   what the person may do there. Every `connect` and `watchQuery` counts
//   against their requests of the App (`admitted`), and each connection
//   is recorded (`recordPortableUse`).
// - A flood of pushes: the same bounds as a tab's (query-subscriptions.ts:
//   queries per connection, reads at once, what waits to be pushed), the
//   person's live reads of the App shared with their tabs.

/** How long a connection may take to authenticate before it is closed. */
const connectWithinMs = 10_000;

/** The App ID in `pathname`, if it is a live connection's path. */
export const liveConnectionApp = (pathname: string): string | undefined =>
  appAfter(pathname, portableLivePath);

/** A connection's socket, closed only from a request that may touch it. */
const socketOf = (server: WebSocket) => {
  /**
   * Whether the socket is open and belongs to the request running now
   * (rpc.ts says why a timer may run elsewhere).
   */
  const openHere = (): boolean => {
    try {
      return server.readyState === WebSocket.OPEN;
    } catch {
      return false;
    }
  };
  return {
    openHere,
    close: (code: number, reason: string): void => {
      if (openHere()) {
        server.close(code, reason);
      }
    },
  };
};

type Socket = ReturnType<typeof socketOf>;

/** A token refused, as the refusal its caller gets; logged when genuine. */
const tokenRefusal = (
  checked: Exclude<TokenCheck, { ok: true }>,
  app: string
): Error => {
  if (checked.reason === "keys_pending") {
    return authErrors.create("auth.token_unavailable");
  }
  if (checked.reason !== "invalid") {
    logRefusedToken({
      app: app.slice(0, 128),
      reason: checked.reason,
      userId: checked.userId,
      sessionId: checked.sessionId,
      route: "live",
    });
  }
  return authErrors.create("auth.unauthenticated");
};

/** What one authenticated connection holds of its token. */
interface Held {
  token: string;
  expiresAt: number;
  sessionId: string;
}

/**
 * The App's live queries, for the person whose token connected (see the
 * header): followed through `QuerySubscriptions`, as a tab's are.
 */
export class PortableQueriesRpc
  extends CoreRpcTarget
  implements PortableQueriesApi
{
  readonly #env: Env;
  readonly #app: AppId;
  readonly #userId: string;
  readonly #socket: Socket;
  readonly #held: Held;
  readonly #check: () => Promise<Identity>;
  readonly #queries: QuerySubscriptions;
  #ended = false;
  #recheck: ReturnType<typeof setTimeout> | undefined;
  #expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    env: Env,
    { app, person, held }: { app: AppId; person: Identity; held: Held },
    socket: Socket,
    server: WebSocket
  ) {
    super();
    this.#env = env;
    this.#app = app;
    this.#userId = person.userId;
    this.#socket = socket;
    this.#held = held;
    this.#check = recheckedEvery(
      sessionRecheckMs,
      async () => await this.#read()
    );
    const hasRole = stillHasRole(env, this.#check, app);
    this.#queries = new QuerySubscriptions(
      env,
      screenReads(env, this.#check, async (by, id, artifact) => {
        if (!(await hasRole())) {
          return "role";
        }
        const open = await deliveryOpen(env, by, id, artifact, {
          operation: "portable.watchQuery",
          stage: "push",
        });
        return open ? "open" : "build";
      })
    );
    const end = (): void => {
      this.#ended = true;
      clearTimeout(this.#recheck);
      clearTimeout(this.#expiry);
    };
    server.addEventListener("close", end);
    server.addEventListener("error", end);
    // `connect` has just read the token: the next reading is due a
    // window on, and its expiry at its `exp`.
    this.#recheckWhenDue();
    this.#expireWhenDue();
  }

  /**
   * Who the connection's token lets read now (see the header): closes
   * the connection once it doesn't, after the refusal for a session that
   * ended, before anything for one that only expired.
   */
  async #read(): Promise<Identity> {
    this.#recheckWhenDue();
    if (Date.now() >= this.#held.expiresAt) {
      this.#expire();
      throw authErrors.create("auth.unauthenticated");
    }
    const checked = await checkAppToken(this.#env, this.#held.token, this.#app);
    if (checked.ok && checked.person.userId === this.#userId) {
      return checked.person;
    }
    if (!checked.ok && checked.reason === "keys_pending") {
      // Not a refusal of the person: the host connects again.
      this.#socket.close(sessionEndedCloseCode, "Token unreadable");
      throw authErrors.create("auth.token_unavailable");
    }
    // After the refusal is on its way to the host.
    setTimeout(() => {
      this.#socket.close(sessionEndedCloseCode, "Session ended");
    }, 0);
    throw authErrors.create("auth.unauthenticated");
  }

  /** Closes the connection as expired, while its token still is. */
  #expire(): void {
    if (Date.now() >= this.#held.expiresAt) {
      this.#socket.close(tokenExpiredCloseCode, "Token expired");
    }
  }

  /** Has the token read again as the latest reading runs out. */
  #recheckWhenDue(): void {
    clearTimeout(this.#recheck);
    if (this.#ended) {
      return;
    }
    this.#recheck = setTimeout(() => {
      if (!this.#ended && this.#socket.openHere()) {
        void this.#checkQuietly();
      }
    }, sessionRecheckMs);
  }

  async #checkQuietly(): Promise<void> {
    try {
      await this.#check();
    } catch {
      // A refused token has closed the connection; a reading that failed
      // is made again at the next tick or call.
    }
  }

  /** Closes the connection at the token's `exp`, unless renewed by then. */
  #expireWhenDue(): void {
    clearTimeout(this.#expiry);
    if (this.#ended) {
      return;
    }
    this.#expiry = setTimeout(
      () => {
        this.#expire();
      },
      Math.max(0, this.#held.expiresAt - Date.now())
    );
  }

  async renew(token: string): Promise<{ expiresAt: number }> {
    if (typeof token !== "string") {
      throw authErrors.create("auth.unauthenticated");
    }
    const checked = await checkAppToken(this.#env, token, this.#app);
    if (!checked.ok) {
      // The token held goes on until its own `exp`.
      throw tokenRefusal(checked, this.#app);
    }
    if (checked.person.userId !== this.#userId) {
      setTimeout(() => {
        this.#socket.close(sessionEndedCloseCode, "Principal changed");
      }, 0);
      throw authErrors.create("auth.principal_changed");
    }
    if (checked.sessionId !== this.#held.sessionId) {
      await recordPortableUse(
        this.#env,
        checked.person,
        this.#app,
        checked.sessionId
      );
    }
    Object.assign(this.#held, {
      token,
      expiresAt: checked.expiresAt,
      sessionId: checked.sessionId,
    });
    this.#expireWhenDue();
    return { expiresAt: checked.expiresAt };
  }

  async watchQuery(
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ): Promise<RunSubscription> {
    const by = await this.#check();
    const env = this.#env;
    // Following is a request like any other; what core then pushes is
    // not counted (query-subscriptions.ts bounds it).
    const id = await admitted(env, by, this.#app);
    if (
      typeof request !== "string" ||
      request.length > functionRequestMaxBytes ||
      !isStub(onSnapshot)
    ) {
      throw screenErrors.create("screen.invalid");
    }
    // No build core approved: the host's code isn't core's to deliver.
    await requireDelivery(env, by, id, undefined, {
      operation: "portable.watchQuery",
      stage: "admission",
    });
    return this.#queries.subscribe(by, id, undefined, request, onSnapshot);
  }
}

/**
 * What a live connection reaches before it authenticates: `connect`,
 * once (see the header).
 */
export class PortableLiveRpc extends CoreRpcTarget implements PortableLiveApi {
  readonly #env: Env;
  readonly #app: string;
  readonly #server: WebSocket;
  readonly #socket: Socket;
  #asked = false;
  readonly #deadline: ReturnType<typeof setTimeout>;

  constructor(env: Env, app: string, server: WebSocket) {
    super();
    this.#env = env;
    this.#app = app;
    this.#server = server;
    this.#socket = socketOf(server);
    this.#deadline = setTimeout(() => {
      this.#socket.close(sessionEndedCloseCode, "Not authenticated");
    }, connectWithinMs);
    server.addEventListener("close", () => {
      clearTimeout(this.#deadline);
    });
  }

  async connect(token: string): Promise<PortableQueriesRpc> {
    if (this.#asked) {
      throw authErrors.create("auth.unauthenticated");
    }
    this.#asked = true;
    try {
      if (typeof token !== "string") {
        throw authErrors.create("auth.unauthenticated");
      }
      const checked = await checkAppToken(this.#env, token, this.#app);
      if (!checked.ok) {
        throw tokenRefusal(checked, this.#app);
      }
      const { person, sessionId, expiresAt } = checked;
      const app = await admitted(this.#env, person, this.#app);
      await recordPortableUse(this.#env, person, app, sessionId);
      clearTimeout(this.#deadline);
      return new PortableQueriesRpc(
        this.#env,
        { app, person, held: { token, expiresAt, sessionId } },
        this.#socket,
        this.#server
      );
    } catch (error) {
      // After the refusal is on its way to the host: a new connection
      // with a new token is the way on.
      setTimeout(() => {
        this.#socket.close(sessionEndedCloseCode, "Not authenticated");
      }, 0);
      throw error;
    }
  }
}

/**
 * Opens a portable host's live connection for `app` (see the header):
 * any origin, no cookie read, only `connect` reachable until it answers.
 */
export const portableLiveResponse = (
  request: Request,
  env: Env,
  app: string,
  requestId: string
): Response => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    const response = errorResponse(
      426,
      requestErrors.create("request.upgrade_required"),
      requestId
    );
    response.headers.set("Upgrade", "websocket");
    return response;
  }
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  serveRpc(
    server,
    new PortableLiveRpc(env, app, server),
    coreRpcAccounting,
    requestId
  );
  return new Response(null, { status: 101, webSocket: client });
};
