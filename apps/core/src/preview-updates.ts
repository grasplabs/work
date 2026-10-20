import { platformLimits } from "@grasp-os/shared/platform-limits";

// The updates of a chat's preview of its draft of an App: each of the
// draft's writes loads the preview afresh (`chats.preview`, chats-rpc.ts),
// building the draft's screens again. Spec 18.1 holds one preview session
// to `previewUpdatesInFlight` updates building at once and
// `previewUpdatesPending` waiting their turn; a newer update replaces the
// oldest waiting one, which is refused as superseded, so a draft written
// faster than it builds builds its latest revision next and never piles
// builds up. These are the Workspace object's (workspace.ts), which holds
// the chat, so every connection of its person shares them.
//
// Each update loads a fresh frame, so no preview keeps modules across
// revisions: spec 18.1's module reset (`previewResetRevisions`,
// `previewResetBytes`) happens at every one, well within it.

/**
 * How long an update holds its place before another may take it, settled
 * or not: a preview's load is one call, which a Worker never lets run
 * longer than a server invocation's wall time. Only a load that never
 * settled (its isolate went away mid-build) waits this long.
 */
export const previewUpdateLeaseMs = platformLimits.serverInvocationWallMs;

/**
 * How long an update that waited holds the place it was given before its
 * caller confirms it is loading (`confirm`): a caller that went away while
 * it waited never does, and its place is free again this soon.
 */
export const previewUpdateConfirmMs = 5000;

interface Waiting {
  token: string;
  go: (taken: boolean) => void;
}

/** One preview session's updates: those building, by when their place ends, and those waiting. */
interface Session {
  running: Map<string, number>;
  waiting: Waiting[];
}

/** Frees the places of updates past their lease. */
const expire = (session: Session): void => {
  const now = Date.now();
  for (const [token, until] of session.running) {
    if (now > until) {
      session.running.delete(token);
    }
  }
};

/** Milliseconds until the first building update's place ends. */
const untilFree = (session: Session): number => {
  const first = Math.min(Date.now(), ...session.running.values());
  return Math.max(0, first - Date.now()) + 1;
};

/**
 * Lets waiting updates take the free places, in the order they came, each
 * for as long as its caller takes to confirm it.
 */
const fill = (session: Session): void => {
  while (session.running.size < platformLimits.previewUpdatesInFlight) {
    const next = session.waiting.shift();
    if (next === undefined) {
      return;
    }
    session.running.set(next.token, Date.now() + previewUpdateConfirmMs);
    next.go(true);
  }
};

/** The preview sessions of one Workspace object's chats, by chat and App. */
export class PreviewUpdates {
  readonly #sessions = new Map<string, Session>();
  /** This instance's own: a token from before a restart settles nothing. */
  readonly #instance = crypto.randomUUID();
  #next = 0;

  /**
   * A place for an update of the preview `key` names: its token once it
   * may build, after waiting its turn if it must, or null when a newer
   * update replaced it before its turn came. One that waited holds its
   * place briefly until `confirm`.
   */
  async take(key: string): Promise<string | null> {
    const session = this.#session(key);
    // Ones that waited longer go first, an expired one's place too.
    expire(session);
    fill(session);
    this.#next += 1;
    const token = `${this.#instance}:${this.#next}`;
    if (session.running.size < platformLimits.previewUpdatesInFlight) {
      session.running.set(token, Date.now() + previewUpdateLeaseMs);
      return token;
    }
    if (session.waiting.length >= platformLimits.previewUpdatesPending) {
      session.waiting.shift()?.go(false);
    }
    const turn = Promise.withResolvers<boolean>();
    session.waiting.push({ token, go: turn.resolve });
    // Woken by a settled update, or else once the place of the first one
    // building ends: it never settles when its isolate went away.
    void this.#wakeAfterLease(key, session, token);
    return (await turn.promise) ? token : null;
  }

  /** Update `token` of the preview `key` names is loading: it holds its place for the whole lease. */
  confirm(key: string, token: string): void {
    const running = this.#sessions.get(key)?.running;
    if (running?.has(token) === true) {
      running.set(token, Date.now() + previewUpdateLeaseMs);
    }
  }

  /** Ends update `token` of the preview `key` names, and lets the next take its place. */
  settle(key: string, token: string): void {
    const session = this.#sessions.get(key);
    if (session?.running.delete(token) !== true) {
      return;
    }
    this.#promote(key, session);
  }

  #session(key: string): Session {
    const known = this.#sessions.get(key);
    if (known !== undefined) {
      return known;
    }
    const made: Session = { running: new Map(), waiting: [] };
    this.#sessions.set(key, made);
    return made;
  }

  /** Lets `token` take a place once the place of each update ahead of it ends, while it still waits. */
  async #wakeAfterLease(
    key: string,
    session: Session,
    token: string
  ): Promise<void> {
    while (session.waiting.some((waiting) => waiting.token === token)) {
      // oxlint-disable-next-line no-await-in-loop -- until its turn comes
      await scheduler.wait(untilFree(session));
      expire(session);
      this.#promote(key, session);
    }
  }

  /** Lets waiting updates take the free places; forgets an idle session. */
  #promote(key: string, session: Session): void {
    fill(session);
    if (
      session.running.size === 0 &&
      session.waiting.length === 0 &&
      this.#sessions.get(key) === session
    ) {
      this.#sessions.delete(key);
    }
  }
}
