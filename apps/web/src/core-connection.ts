// Before anything builds a schema, as in core.ts.
import "./zod-jitless.ts";
import { authErrors } from "@grasp-os/shared/errors";
import type { CoreApi, Identity, SignInOption } from "@grasp-os/shared/rpc";
import type { RpcStub } from "capnweb";

import { setActiveChat } from "./chat/active-chat.ts";
import {
  connectCore,
  CoreTimeoutError,
  deadline,
  isTransient,
  reconnectDelay,
  retrying,
  unlessAborted,
  withTimeout,
} from "./core.ts";
import type { Session } from "./core.ts";

/** Why the person's session ended under the page. */
export type SessionEnded = "signed-out" | "principal-changed";

/** What waiting for a connection is refused with once the session ended so. */
const endedErrors: Readonly<Record<SessionEnded, () => Error>> = {
  "signed-out": () => authErrors.create("auth.unauthenticated"),
  "principal-changed": () => authErrors.create("auth.principal_changed"),
};

const closedError = (): Error =>
  new Error("The page closed its connection to core.");

/** Lets go of a connection, which may be broken already. */
const disposeQuietly = (core: RpcStub<CoreApi>): void => {
  try {
    core[Symbol.dispose]();
  } catch {
    // Broken already.
  }
};

/** Waits for `promise` to settle, whichever way. */
const settled = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // Whoever needs the outcome awaits the promise itself.
  }
};

/** A connection that answered: core's API, and the signed-in person's. */
interface Connected {
  api: RpcStub<CoreApi>;
  /** None for a connection nobody is signed in on. */
  session?: Session;
  person?: Identity;
}

/** `api` with its signed-in API and who that is for; refused for nobody. */
const signedIn = async (api: RpcStub<CoreApi>): Promise<Connected> => {
  const session = await api.authenticate();
  return { api, session, person: await session.whoami() };
};

/**
 * `api` once it has said who is signed in on it, which is the first thing
 * every connection is asked. Core out of reach or failing rejects; nobody
 * signed in is an answer.
 */
const answered = async (api: RpcStub<CoreApi>): Promise<Connected> => {
  try {
    return await withTimeout(signedIn(api));
  } catch (error) {
    if (authErrors.codeOf(error) === "auth.unauthenticated") {
      return { api };
    }
    throw error;
  }
};

/**
 * Listens for the page coming back (to the tab, or online), when a socket
 * may have died without saying so and a reconnect wait is worth cutting
 * short.
 */
const onPageBack = (back: () => void): void => {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      back();
    }
  });
  window.addEventListener("online", back);
};

/**
 * How a caller waits for the connection. A person waiting (the shell's
 * calls, which give up in a few seconds) cuts a reconnect pause short; an
 * App frame is patient: it waits for the next attempt the backoff makes,
 * so however often a screen asks during an outage, it never adds one.
 */
export interface Waiting {
  patient?: boolean;
}

/** What a tab's connection is made with. */
export interface CoreConnectionOptions {
  /**
   * Called once the person's session ended under the page, after every
   * App frame on the connection was told (main.tsx loads the page again).
   */
  onSessionEnded: () => void;
  /** Opens a connection to core: a stand-in in tests. */
  connect?: () => RpcStub<CoreApi>;
  /** Calls `back` when the page comes back: never in tests. */
  watchPage?: (back: () => void) => void;
}

/**
 * The tab's one connection to core (spec 11.2), which everything the page
 * asks of core goes over: loaders, actions, its status, followed chats,
 * notifications, and the App frames it runs (screens/tab-link.ts), each
 * of which reaches its App through a capability of its own on it (core's
 * `screens.frame`). (A draft's preview alone keeps a connection of its
 * own, screens/core-link.ts.) It opens when first used (a guest's page
 * never uses it) and connects again whenever it drops, for as long as it
 * takes, after a pause of up to 1 to 30 s (`reconnectDelay`), cut short
 * when the page comes back to the tab or online, or a person asks for it
 * (trying again need not wait out the pause; an App frame never cuts it,
 * `Waiting`). Once per pause at most: an attempt starts the next, longer
 * one. Whoever asks for it
 * meanwhile waits for the next connection, in the order they asked: the
 * shell for a few seconds per call (`deadline()`), App frames for as long
 * as it takes. A call already on its way when the connection drops fails,
 * and is never made twice. Stubs passed over a connection that dropped
 * (a followed chat's updates, a frame's capability) break with it; their
 * owners subscribe again on the next.
 *
 * A connection is for whoever was signed in when it first answered.
 * Once a new one finds that person's session gone (signed out, revoked,
 * removed from the organization, or someone else signed in), or the page
 * ends it (`end`: signing out, or a frame told by core that the browser's
 * session is someone else's), it closes for good: every App frame on it
 * is told (`onEnded`) and stops before anything else happens, whoever
 * waits for it or asks later is refused with the ending's own error, and
 * `onSessionEnded` is called. Threat model, each tried in
 * core-connection.test.ts:
 *
 * - Another tab signs in as someone else: this socket stays the first
 *   person's; a connection made again is checked before it is handed
 *   out, and ends the session instead.
 * - A reconnect racing the end: a connection that answers after the end
 *   is let go of, never handed to anyone.
 * - A frame joining after the end: refused with the ending's error, so it
 *   shows the ending, never a stub.
 * - A frame whose stopping throws: the others are told all the same.
 */
export class CoreConnection {
  readonly #onSessionEnded: () => void;
  readonly #connectCore: () => RpcStub<CoreApi>;
  readonly #watchPage: (back: () => void) => void;
  #closed = false;
  /** Refuses whoever waits for a connection once the connection closed. */
  readonly #closing = new AbortController();
  /** Who the first connection that answered was signed in as. */
  #person: Identity | undefined;
  /** The open connection; none while connecting. */
  #live: RpcStub<CoreApi> | undefined;
  #connected: Promise<Connected> | undefined;
  /** Cuts the current reconnect wait short, while there is one. */
  #wake: (() => void) | undefined;
  /** The App frames on the connection, each told once it ends. */
  readonly #frames = new Set<(why: SessionEnded) => void>();

  constructor({
    onSessionEnded,
    connect = connectCore,
    watchPage = onPageBack,
  }: CoreConnectionOptions) {
    this.#onSessionEnded = onSessionEnded;
    this.#connectCore = connect;
    this.#watchPage = watchPage;
  }

  /**
   * Core's API for anyone, signed in or not, once the connection is there:
   * waited for no longer than `signal` allows (a few seconds unless given),
   * then refused with its reason.
   */
  async api(signal = deadline()): Promise<RpcStub<CoreApi>> {
    const { api } = await this.#current(signal, {});
    return api;
  }

  /**
   * The signed-in person's API, once the connection is there, waited for
   * as `api` is. Ask again for each call: one kept from before a drop is of
   * the connection that dropped. Refused as core refuses it when nobody is
   * signed in.
   */
  async session(signal = deadline(), waiting: Waiting = {}): Promise<Session> {
    const { session } = await this.#signedIn(signal, waiting);
    return session;
  }

  /**
   * Who the connection is for, once it is there, waited for as `api` is:
   * the person every connection it hands out is signed in as. Refused when
   * nobody is signed in.
   */
  async person(signal = deadline(), waiting: Waiting = {}): Promise<Identity> {
    const { person } = await this.#signedIn(signal, waiting);
    return person;
  }

  /**
   * Runs `run` with the signed-in person's API ({@link session}). Given up
   * on while it waits for the connection, `run` never runs, so nothing it
   * would call is sent once core is back.
   */
  async withSession<T>(
    run: (session: Session) => Promise<T>,
    signal = deadline()
  ): Promise<T> {
    return await run(await this.session(signal));
  }

  /**
   * Tells `onEnded` once if the person's session ends while it listens.
   * Returns what stops it listening.
   */
  onEnded(onEnded: (why: SessionEnded) => void): () => void {
    this.#frames.add(onEnded);
    return () => {
      this.#frames.delete(onEnded);
    };
  }

  /**
   * Ends the person's session on the page, `why`: as when a new connection
   * finds it gone. Once only; a connection closed already changes nothing.
   */
  end(why: SessionEnded): void {
    if (this.#closed) {
      return;
    }
    this.#close(endedErrors[why]());
    // A copy, emptied first: whoever stops a frame can't be told twice.
    const frames = [...this.#frames];
    this.#frames.clear();
    // Every frame is told, whatever stopping one of them throws: nothing
    // would tell those after it again.
    const failures: unknown[] = [];
    for (const frame of frames) {
      try {
        frame(why);
      } catch (error) {
        failures.push(error);
      }
    }
    // The open chat was this person's: whoever signs in next starts
    // without it, however the session ended.
    setActiveChat(undefined);
    this.#onSessionEnded();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Stopping a frame failed.");
    }
  }

  /**
   * Closes the connection for good: whoever waits for it, or asks later,
   * is refused with `reason`.
   */
  #close(reason: Error): void {
    this.#closed = true;
    this.#closing.abort(reason);
    this.#wake?.();
    if (this.#live !== undefined) {
      disposeQuietly(this.#live);
      this.#live = undefined;
    }
  }

  /** The connection, with someone signed in on it, or refused. */
  async #signedIn(
    signal: AbortSignal,
    waiting: Waiting
  ): Promise<{ session: Session; person: Identity }> {
    const { session, person } = await this.#current(signal, waiting);
    if (session === undefined || person === undefined) {
      throw authErrors.create("auth.unauthenticated");
    }
    return { session, person };
  }

  /**
   * The connection, unless `signal` gives up first or it closes. Checked
   * again once it is there, so what gave up in the same moment isn't sent
   * either.
   */
  async #current(
    signal: AbortSignal,
    { patient = false }: Waiting
  ): Promise<Connected> {
    this.#closing.signal.throwIfAborted();
    // A person wants core now, such as trying again: a reconnect waiting
    // out its pause tries at once. Only a pause is cut short, so however
    // many ask, one attempt is made at a time. App frames never cut it.
    if (!patient) {
      this.#wake?.();
    }
    // One wait that either ends, so a call that gave up during an outage
    // leaves nothing waiting on the connection behind it.
    const connected = await unlessAborted(
      this.#opened(),
      AbortSignal.any([signal, this.#closing.signal])
    );
    this.#closing.signal.throwIfAborted();
    signal.throwIfAborted();
    return connected;
  }

  async #opened(): Promise<Connected> {
    if (this.#connected === undefined) {
      this.#connected = this.#connect();
      this.#watchPage(() => {
        this.#back();
      });
    }
    return await this.#connected;
  }

  /**
   * The pause before reconnect attempt `attempt`, unless the page comes
   * back or the connection closes first.
   */
  async #nap(attempt: number): Promise<void> {
    // Whether the page cut it short; nobody needs to know.
    const woken = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      woken.resolve(false);
    }, reconnectDelay(attempt));
    this.#wake = () => {
      woken.resolve(true);
    };
    try {
      await woken.promise;
    } finally {
      clearTimeout(timer);
      this.#wake = undefined;
    }
  }

  /**
   * A connection that answered, tried until one does: at once the first
   * time, or after a pause for reconnect `attempt`. Only one that answered
   * is handed on: Cap'n Web keeps what is sent while a socket is still
   * connecting, and fails it all at once when it doesn't connect.
   */
  async #connect(attempt?: number): Promise<Connected> {
    let next = attempt;
    for (;;) {
      if (next !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
        await this.#nap(next);
      }
      next = (next ?? -1) + 1;
      if (this.#closed) {
        // Closed while waiting: a new connection would never be closed.
        throw closedError();
      }
      const api = this.#connectCore();
      let connected: Connected;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
        connected = await answered(api);
      } catch {
        disposeQuietly(api);
        continue;
      }
      if (this.#closed) {
        // Closed while it answered: nobody may get it, nothing closes it.
        disposeQuietly(api);
        throw closedError();
      }
      const { person } = connected;
      if (
        this.#person !== undefined &&
        person?.userId !== this.#person.userId
      ) {
        disposeQuietly(api);
        const why = person === undefined ? "signed-out" : "principal-changed";
        this.end(why);
        throw endedErrors[why]();
      }
      this.#person ??= person;
      this.#live = api;
      // Registered after the answer, it still hears of a break before it.
      api.onRpcBroken(() => {
        this.#lost(api);
      });
      return connected;
    }
  }

  /**
   * `api` broke: from now on, whoever asks waits for the next connection.
   * A connection that isn't the open one any more changes nothing.
   */
  #lost(api: RpcStub<CoreApi>): void {
    if (this.#closed || this.#live !== api) {
      return;
    }
    this.#live = undefined;
    this.#connected = this.#connect(0);
    void settled(this.#connected);
  }

  /**
   * The page came back to the tab or online: a reconnect waiting for its
   * pause tries now, and a socket that died while the tab slept, or with
   * the network, which doesn't always say so, is asked whether it still
   * answers, rather than leaving the person's next click to hang on it.
   */
  #back(): void {
    this.#wake?.();
    void this.#probe();
  }

  async #probe(): Promise<void> {
    const api = this.#live;
    if (api === undefined) {
      return;
    }
    try {
      await withTimeout(api.ping());
    } catch {
      this.#lost(api);
      disposeQuietly(api);
    }
  }
}

/** Whether core answers, how people sign in here, and who is signed in. */
export interface CoreStatus {
  connected: boolean;
  signInOptions: SignInOption[];
  identity?: Identity;
}

/** Who is signed in on `core` now, or `undefined` for nobody. */
const signedInAs = async (
  core: CoreConnection,
  signal: AbortSignal
): Promise<Identity | undefined> => {
  try {
    return await core.withSession(
      async (session) => await session.whoami(),
      signal
    );
  } catch (error) {
    if (authErrors.codeOf(error) === "auth.unauthenticated") {
      return undefined;
    }
    throw error;
  }
};

/** Asks core once, as long as `signal` allows. */
const askCoreStatus = async (
  core: CoreConnection,
  signal: AbortSignal
): Promise<CoreStatus> => {
  const api = await core.api(signal);
  const [pong, signInOptions, identity] = await Promise.all([
    api.ping(),
    api.signInOptions(),
    signedInAs(core, signal),
  ]);
  return { connected: pong === "pong", signInOptions, identity };
};

/** How long to wait before asking core for its status again, each time. */
const statusRetryMs = [250, 500, 1000] as const;

/**
 * Asks core over RPC whether it answers, how people sign in here and who is
 * signed in. Core failing or out of reach is asked again a few times, with
 * a growing pause, before it counts as unreachable: one failed request must
 * not look like nobody being signed in. A connection that hangs past the
 * timeout counts as unreachable at once; it has had its few seconds.
 */
export const loadCoreStatus = async (
  core: CoreConnection
): Promise<CoreStatus> => {
  try {
    return await retrying(
      async () => {
        const signal = deadline();
        return await unlessAborted(askCoreStatus(core, signal), signal);
      },
      statusRetryMs,
      (failure) =>
        isTransient(failure) && !(failure instanceof CoreTimeoutError)
    );
  } catch {
    return { connected: false, signInOptions: [] };
  }
};

/**
 * `read` on the signed-in person's API over `core`, within a few seconds
 * all told (or as long as `signal` allows): the wait for a connection and
 * for the answer. Given up on while it waits for the connection, `read`
 * never runs, so it is never sent once core is back; sent already, only
 * its answer is no longer waited for.
 */
export const readWithin = async <T>(
  core: Pick<CoreConnection, "withSession">,
  read: (session: Session) => Promise<T>,
  signal = deadline()
): Promise<T> => await unlessAborted(core.withSession(read, signal), signal);

/**
 * Ends this browser's session and the tab's connection, which stops every
 * App frame on it and loads the page again, signed out (`onSessionEnded`).
 */
export const signOut = async (core: CoreConnection): Promise<void> => {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  core.end("signed-out");
};
