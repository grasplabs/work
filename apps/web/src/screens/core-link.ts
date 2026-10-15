import { authErrors } from "@grasp-os/shared/errors";

import { connectCore, isTransient, retrying, wait } from "../core.ts";

/** A signed-in session's API, as a connection to core gives it. */
type Session = Awaited<
  ReturnType<ReturnType<typeof connectCore>["authenticate"]>
>;

/** How long to wait before connecting again, at first and at most. */
const reconnectMs = { first: 1000, most: 30_000 };

/**
 * The pauses before trying again what a page needs to start: its first
 * connection, or its first call. The same growing pauses as reconnecting,
 * but only a few, so a page whose core stays out of reach says so.
 */
const startRetryMs = [
  reconnectMs.first,
  reconnectMs.first * 2,
  reconnectMs.first * 4,
] as const;

const closedError = (): Error =>
  new Error("The page closed its connection to core.");

/** Why a link ended for good, before anyone closed it. */
export type LinkEnded = "signed-out" | "principal-changed";

/** Core's refusals of a connection that end the link, and how. */
const endings: Readonly<Record<string, LinkEnded>> = {
  "auth.unauthenticated": "signed-out",
  "auth.principal_changed": "principal-changed",
};

/** The person `whoami` answered, or `undefined` for an answer without one. */
const personOf = (identity: unknown): string | undefined => {
  const userId: unknown =
    typeof identity === "object" && identity !== null
      ? Reflect.get(identity, "userId")
      : undefined;
  return typeof userId === "string" && userId.length > 0 ? userId : undefined;
};

/** Waits for `promise` to settle, whichever way. */
const settled = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // Whoever needs the outcome awaits the promise itself.
  }
};

/**
 * A page's long-lived connection to core: a Cap'n Web session that
 * connects again when it drops, until the person's session has ended.
 * Stubs passed over the old connection (a screen's callbacks) break with
 * it; their owners subscribe again on the new one.
 *
 * A link is for one person: the one core says is signed in when it first
 * connects. Connecting again sends whatever session cookie the browser
 * holds by then, which may be someone else's: another tab signed out and
 * in as them. Then the link ends (`principal-changed`) before anyone gets
 * the new connection, so nothing its owner holds for the first person
 * (a screen's data, a save whose answer was lost) is ever sent as the
 * next. Threat model:
 *
 * - Two tabs: the other tab's sign-in changes the cookie, not this
 *   connection. A call on it still goes as the first person; only a
 *   connection made again is someone else's, and it is checked before
 *   it is handed out. What goes by plain request instead (a screen's
 *   function calls) names the link's person, and core refuses it for
 *   anyone else's cookie (core's app-function-route.ts).
 * - A reconnect racing a call: a call made while the link connects again
 *   waits for the new connection, and gets the refusal instead of it.
 *   One sent on the old connection breaks with it.
 * - The same person on a new session, or signed out and in again: still
 *   the link's person, so it goes on. Keys are the person's, so a save
 *   sent again is still theirs, once.
 * - Signed out: the link ends (`signed-out`).
 * - `whoami` failing: tried again, as any failure that may pass; an
 *   answer that names nobody counts as signed out.
 */
export class CoreLink {
  #session: Promise<Session>;
  #core: ReturnType<typeof connectCore> | undefined;
  #closed = false;
  #delay = reconnectMs.first;
  /** Who the link is for, once it first connected. */
  #person: string | undefined;
  /** Core's refusal that ended the link, once one did. */
  #endedBy: Error | undefined;
  readonly #onEnded: (why: LinkEnded) => void;

  constructor(onEnded: (why: LinkEnded) => void) {
    this.#onEnded = onEnded;
    // Core failing or out of reach is tried again on the first connection
    // too, a few times: only a connection that worked reconnects when it
    // breaks. A refusal, such as the session having ended, is core's answer.
    this.#session = retrying(
      async () => {
        if (this.#closed) {
          // Closed while waiting: a new connection would never be closed.
          throw closedError();
        }
        return await this.#connect();
      },
      startRetryMs,
      (failure) => !this.#closed && isTransient(failure)
    );
    void this.#started(this.#session);
  }

  /**
   * Whether the link's first connection failed for good, or it was closed
   * before it connected: it never connects then, and whoever wants core
   * opens a new link (tab-link.ts).
   */
  get failedToStart(): boolean {
    return this.#startFailed;
  }

  #startFailed = false;

  /** Notes whether `first`, the first connection, failed. */
  async #started(first: Promise<Session>): Promise<void> {
    try {
      await first;
    } catch {
      this.#startFailed = true;
    }
  }

  /** The signed-in session, once connected. */
  async session(): Promise<Session> {
    return await this.#session;
  }

  /**
   * Who the link is for, once connected: waits for a connection being
   * made again, and fails when it turned out to be someone else's.
   */
  async person(): Promise<string> {
    await this.#session;
    if (this.#endedBy !== undefined) {
      throw this.#endedBy;
    }
    const person = this.#person;
    if (person === undefined || this.#closed) {
      throw closedError();
    }
    return person;
  }

  /**
   * Runs `run` on the signed-in session, and a few times again, with a
   * growing pause, while it fails in a way that may pass: core failing, or
   * the connection breaking. After a break, the next try waits for the new
   * connection, and a connection that once worked reconnects for as long
   * as it takes, so that wait has no bound. Not connecting at all fails at
   * once: the first connection has tried again already.
   */
  async retrying<T>(run: (session: Session) => Promise<T>): Promise<T> {
    let connected = false;
    return await retrying(
      async () => {
        connected = false;
        const session = await this.session();
        connected = true;
        return await run(session);
      },
      startRetryMs,
      (failure) => connected && !this.#closed && isTransient(failure)
    );
  }

  close(): void {
    this.#closed = true;
    this.#drop();
  }

  /** Lets go of the current connection, which no longer counts as ours. */
  #drop(): void {
    const core = this.#core;
    this.#core = undefined;
    core?.[Symbol.dispose]();
  }

  async #connect(): Promise<Session> {
    // A failed attempt's connection, before opening the next.
    this.#drop();
    const core = connectCore();
    this.#core = core;
    const session = core.authenticate();
    // Core's own answer, never an App's: the session holds, or it ended,
    // and for whom. Checked before the connection is handed to anyone.
    const person = personOf(await session.whoami());
    const ready = await session;
    if (person === undefined) {
      throw authErrors.create("auth.unauthenticated");
    }
    this.#person ??= person;
    if (person !== this.#person) {
      throw authErrors.create("auth.principal_changed");
    }
    this.#delay = reconnectMs.first;
    // Only a connection that worked starts a reconnect when it breaks, and
    // only once: a failed attempt is retried by the loop that made it, so
    // nothing is awaited once this is registered. Registered after the
    // last answer, it still hears of a break before it.
    core.onRpcBroken(() => {
      if (!this.#closed && this.#core === core) {
        this.#drop();
        const next = this.#reconnect();
        void settled(next);
        this.#session = next;
      }
    });
    return ready;
  }

  async #reconnect(): Promise<Session> {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await wait(this.#delay);
      if (this.#closed) {
        // Closed while waiting: a new connection would never be closed.
        throw closedError();
      }
      this.#delay = Math.min(this.#delay * 2, reconnectMs.most);
      try {
        // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
        return await this.#connect();
      } catch (error) {
        const code = authErrors.codeOf(error);
        const ended = code === undefined ? undefined : endings[code];
        if (this.#closed || ended !== undefined) {
          if (ended !== undefined && !this.#closed) {
            // Closed first: the connection someone else's cookie made goes.
            this.#endedBy =
              code === undefined ? undefined : authErrors.create(code);
            this.close();
            this.#onEnded(ended);
          }
          throw error;
        }
      }
    }
  }
}
