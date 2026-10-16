import {
  portableLivePath,
  tokenExpiredCloseCode,
} from "@grasp-os/shared/portable";
import type {
  PortableLiveApi,
  PortableQueriesApi,
} from "@grasp-os/shared/portable";
import { RpcSession, WebSocketTransport } from "capnweb";
import type { RpcStub } from "capnweb";

import type { PortableToken } from "./client-portable.ts";

// A portable host's live connection to core (spec 11; core's
// portable-live.ts): one WebSocket per App, speaking Cap'n Web, which the
// client follows that App's queries over, as a screen follows them over
// its frame. The person's App token goes in the connection's first call,
// never in the URL; the browser's cookies, which it sends with the
// upgrade whatever the client does, are never read by core.
//
// - A connection outliving its token: before the token's `exp` the client
//   asks for the next one and swaps it in (`renew`). Core closes a
//   connection whose token expired unrenewed with `tokenExpiredCloseCode`;
//   the client then forgets the token, so the next connection asks the
//   host for a fresh one, and every query follows again from a fresh read.
// - One person's connection used for another: a connection is opened for
//   the person its token names and used only while the token the client
//   would send now names them too. A renewal or a new follow that finds
//   someone else closes it (the client clears what it holds first,
//   client-core.ts), and core refuses a renewal for anyone else.
// - Connections piling up: one per App, closed `idleMs` after the last of
//   its queries is released, and at once on a fence.

/** How long a connection with nothing followed stays open for the next. */
const idleMs = 30_000;

/** How long before its token's `exp` a connection swaps in the next. */
const renewBeforeMs = 30_000;

/** How the client reaches a live connection's token, and lets go of one. */
export interface LiveTokens {
  /** The person's token now, checked for a change of person first. */
  readonly token: () => Promise<PortableToken>;
  /** Core refused the token as expired: the next is asked of the host. */
  readonly forget: () => void;
}

/** One App's live connection. */
interface Link {
  readonly app: string;
  readonly principal: string;
  readonly socket: WebSocket;
  readonly queries: RpcStub<PortableQueriesApi>;
  /** Queries followed over it now. */
  followed: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  renewal: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
}

/** A subscription core answered: released, and let go of, once. */
type Held = Awaited<ReturnType<RpcStub<PortableQueriesApi>["watchQuery"]>>;

/** Releases `held` and lets go of its stub, quietly. */
const releaseQuietly = async (held: Held): Promise<void> => {
  try {
    await held.release();
  } catch {
    // Core lets go of it anyway once the connection goes.
  } finally {
    held[Symbol.dispose]();
  }
};

/** A portable host's live connections, one per App (see the header). */
export class PortableLive {
  readonly #origin: string;
  readonly #tokens: LiveTokens;
  readonly #links = new Map<string, Link>();

  constructor(origin: string, tokens: LiveTokens) {
    this.#origin = origin;
    this.#tokens = tokens;
  }

  /** The URL of `app`'s live connection: the deployment's, over `ws(s):`. */
  #urlOf(app: string): string {
    const url = new URL(
      `${portableLivePath}/${encodeURIComponent(app)}`,
      this.#origin
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  /**
   * `app`'s connection for the person `token` names: the one open, or a
   * new one. One open for someone else is closed first.
   */
  #linkFor(app: string, token: PortableToken): Link {
    const open = this.#links.get(app);
    if (open !== undefined && !open.closed) {
      if (open.principal === token.principal) {
        return open;
      }
      this.#close(open);
    }
    const socket = new WebSocket(this.#urlOf(app));
    const main = new RpcSession<PortableLiveApi>(
      new WebSocketTransport(socket)
    ).getRemoteMain();
    const link: Link = {
      app,
      principal: token.principal,
      socket,
      queries: main.connect(token.text),
      followed: 0,
      idle: undefined,
      renewal: undefined,
      closed: false,
    };
    socket.addEventListener("close", (event) => {
      if (event.code === tokenExpiredCloseCode) {
        this.#tokens.forget();
      }
      this.#gone(link);
    });
    socket.addEventListener("error", () => {
      this.#gone(link);
    });
    this.#links.set(app, link);
    this.#renewWhenDue(link, token);
    return link;
  }

  /** Forgets `link` once its socket went, however it went. */
  #gone(link: Link): void {
    link.closed = true;
    clearTimeout(link.idle);
    clearTimeout(link.renewal);
    if (this.#links.get(link.app) === link) {
      this.#links.delete(link.app);
    }
  }

  /** Closes `link`: everything followed over it is lost. */
  #close(link: Link): void {
    this.#gone(link);
    try {
      link.socket.close(1000, "Closed by the client");
    } catch {
      // Closed already.
    }
    link.queries[Symbol.dispose]();
  }

  /**
   * Swaps in the person's next token shortly before `token`'s `exp`: a
   * token of someone else's closes the connection instead.
   */
  #renewWhenDue(link: Link, token: PortableToken): void {
    clearTimeout(link.renewal);
    if (token.expiresAt === undefined) {
      return;
    }
    link.renewal = setTimeout(
      () => {
        void this.#renew(link);
      },
      Math.max(0, token.expiresAt - renewBeforeMs - Date.now())
    );
  }

  async #renew(link: Link): Promise<void> {
    if (link.closed) {
      return;
    }
    let next: PortableToken;
    try {
      next = await this.#tokens.token();
    } catch {
      // No token now: core closes the connection at the old one's `exp`,
      // and the queries follow again once there is one.
      return;
    }
    if (link.closed) {
      return;
    }
    if (next.principal !== link.principal) {
      this.#close(link);
      return;
    }
    try {
      await link.queries.renew(next.text);
      this.#renewWhenDue(link, next);
    } catch {
      // Refused: the old token goes on until its `exp`, when core closes
      // the connection and the queries follow again with a fresh one.
    }
  }

  /**
   * Follows the query `request` names of `app` (`ClientTransport.watch`):
   * `onSnapshot` gets each push, `onLost` is called once core, or the
   * connection, let go of it.
   */
  async watch(
    app: string,
    request: string,
    onSnapshot: (push: unknown) => void,
    onLost: () => void
  ): Promise<{ release: () => void }> {
    const token = await this.#tokens.token();
    const link = this.#linkFor(app, token);
    link.followed += 1;
    clearTimeout(link.idle);
    link.idle = undefined;
    let counted = true;
    const uncount = (): void => {
      if (!counted) {
        return;
      }
      counted = false;
      link.followed -= 1;
      if (link.followed === 0 && !link.closed) {
        link.idle = setTimeout(() => {
          if (link.followed === 0) {
            this.#close(link);
          }
        }, idleMs);
      }
    };
    // The subscription's stub once core answered, and whether core let
    // go of it first; its stub is let go of once, whichever comes.
    const state: { held?: Held; lost: boolean; gone: boolean } = {
      lost: false,
      gone: false,
    };
    const letGo = (): void => {
      if (state.held !== undefined && !state.gone) {
        state.gone = true;
        state.held[Symbol.dispose]();
      }
    };
    const callback = Object.assign(
      (snapshot: unknown): void => {
        onSnapshot(snapshot);
      },
      {
        [Symbol.dispose]: (): void => {
          state.lost = true;
          letGo();
          uncount();
          onLost();
        },
      }
    );
    try {
      state.held = await link.queries.watchQuery(request, callback);
    } catch (error) {
      uncount();
      throw error;
    }
    if (state.lost) {
      letGo();
    }
    return {
      release: () => {
        uncount();
        if (state.held !== undefined && !state.gone) {
          state.gone = true;
          void releaseQuietly(state.held);
        }
      },
    };
  }

  /** Closes every connection: the person changed, or lost access. */
  closeAll(): void {
    for (const link of this.#links.values()) {
      this.#close(link);
    }
  }
}
