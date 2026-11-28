import { agentErrors } from "@grasp-os/shared/agent";
import {
  applyOutput,
  applyPartial,
  chatToolEventsKept,
} from "@grasp-os/shared/chat";
import type {
  ChatHistoryPage,
  ChatMade,
  ChatMessage,
  ChatOutput,
  ChatPartial,
  ChatProvenance,
  ChatQueued,
  ChatToolEvent,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { authErrors, failureText } from "@grasp-os/shared/errors";
import type { ModelWait } from "@grasp-os/shared/models";
import type { SubscriptionApi } from "@grasp-os/shared/pages";
import { RpcStub } from "capnweb";

import type { CoreConnection } from "../core-connection.ts";
import { CoreTimeoutError, isTransient, retrying, wait } from "../core.ts";
import type { Session } from "../core.ts";

// Following one chat as it streams (`chats.watch` in core), on the tab's
// connection, which connects again when it drops. After a drop, the watch starts
// again after the last message this page has, so nothing is missed or
// shown twice; a reload starts from the first. The person's list of chats
// is followed the same way (chat-list.ts).

/** A chat as the page shows it, put together from its updates. */
export interface ChatView {
  messages: ChatMessage[];
  /** The response being written; `null` between responses. */
  partial: ChatPartial | null;
  /** What the running code step has logged so far; `null` while none runs. */
  output: ChatOutput | null;
  /** The calls the chat's code made, oldest first: the latest core keeps. */
  tools: ChatToolEvent[];
  running: boolean;
  /** The questions sent while it runs that its agent hasn't taken yet, oldest first. */
  queued: ChatQueued[];
  provenance: ChatProvenance;
  /** Why the last question stopped short; `null` once another starts. */
  stopped: string | null;
  /** Changes whenever the agent had a write held: read them again. */
  held: number;
  /** Changes whenever the agent writes an App's draft: read what it worked on again. */
  worked: number;
  /** Whether the turn checks the drafts it wrote now, past its answer. */
  checking: boolean;
  /** What the turn's model request waits on now, if anything. */
  waiting: ModelWait | null;
  /** Whether the first update has come. */
  loaded: boolean;
  /**
   * Whether the chat has messages before the first of `messages`: its
   * watch sends the newest page (`ChatUpdate.older`), and older ones are
   * read a page at a time as the person scrolls back (`withOlder`).
   */
  older: boolean;
  /**
   * What each Build it the chat's agent answered made, as core read it
   * from the whole chat as the tab began to follow it
   * (`ChatUpdate.answeredBuilds`), whichever page holds it.
   */
  answeredBuilds: readonly ChatMade[];
  /**
   * Where the person had read the chat to as the tab began to follow it
   * (`ChatUpdate.seenUpTo`), from the first update; none before it.
   */
  seenUpTo?: number | null;
  /**
   * Whether it is the tab's last view of the chat (chat-watch.ts), shown
   * until its watch's first update replaces it.
   */
  stale?: boolean;
  /**
   * Whether the tab follows it again after a dropped connection and has
   * heard nothing yet since: what it shows may be behind.
   */
  resuming?: boolean;
}

export const emptyView: ChatView = {
  messages: [],
  partial: null,
  output: null,
  tools: [],
  running: false,
  queued: [],
  provenance: { sources: [], restricted: false },
  stopped: null,
  held: 0,
  worked: 0,
  checking: false,
  waiting: null,
  loaded: false,
  older: false,
  answeredBuilds: [],
};

/** `kept` with `added` merged by ID, oldest first, the latest core keeps. */
const mergedTools = (
  kept: readonly ChatToolEvent[],
  added: readonly ChatToolEvent[] | undefined
): ChatToolEvent[] => {
  if (added === undefined || added.length === 0) {
    return [...kept];
  }
  const byId = new Map(kept.map((event) => [event.id, event]));
  for (const event of added) {
    byId.set(event.id, event);
  }
  return [...byId.values()]
    .toSorted((a, b) => a.id - b.id)
    .slice(-chatToolEventsKept);
};

/** `view` with `update` applied: new messages and calls added once, in order. */
export const applyUpdate = (view: ChatView, update: ChatUpdate): ChatView => {
  const last = view.messages.at(-1)?.id ?? 0;
  return {
    messages: [
      ...view.messages,
      ...update.messages.filter(({ id }) => id > last),
    ],
    partial: applyPartial(view.partial, update.partial),
    output: applyOutput(view.output, update.output),
    tools: mergedTools(view.tools, update.tools),
    running: update.running,
    queued: update.queued ?? [],
    // Sent first, then only when it changes.
    provenance: update.provenance ?? view.provenance,
    stopped: update.stopped,
    held: update.held,
    worked: update.worked,
    checking: update.checking ?? false,
    waiting: update.waiting ?? null,
    loaded: true,
    // From the first update: a watch started again later says it again.
    seenUpTo: view.loaded ? view.seenUpTo : update.seenUpTo,
    // From the first update; a watch taken up again sends only what came
    // since, which leaves it as it was.
    older: view.loaded ? view.older : (update.older ?? false),
    answeredBuilds: view.loaded
      ? view.answeredBuilds
      : (update.answeredBuilds ?? []),
  };
};

/**
 * `view` with an older page of its chat (`ChatsApi.history`) put before
 * its messages, when it was read before the first of them: one read for
 * a view replaced since (its first update, over a kept view) is let go.
 */
export const withOlder = (
  view: ChatView,
  before: number,
  page: ChatHistoryPage
): ChatView =>
  view.messages[0]?.id === before
    ? {
        ...view,
        messages: [
          ...page.messages.filter(({ id }) => id < before),
          ...view.messages,
        ],
        older: page.older,
      }
    : view;

/**
 * The pauses before trying again to start following while core fails: only
 * a few, so a chat whose core keeps failing says so. The first try, as the
 * chat opens, waits a few seconds for the tab's connection, and says core
 * can't be reached if none comes; a try after the connection dropped waits
 * for the next one as long as it takes, so a chat (or the list) is
 * followed again the moment core is back, however long it was gone.
 */
const startRetryMs = [1000, 2000, 4000] as const;

/** Lets go of a watch; one whose connection is gone already is let go. */
const releaseQuietly = async (subscription: {
  release: () => Promise<void>;
}): Promise<void> => {
  try {
    await subscription.release();
  } catch {
    // The connection is gone, and core drops the watch with it.
  }
};

/** The pauses between tries to follow what is followed until sign-out: longer each time, then the longest. */
const untilSignedOutMs = [1000, 2000, 4000, 8000, 15_000] as const;

/**
 * `attempt` until it succeeds, waiting longer between tries: given up only
 * once the person's session ended (signed out) or following stopped.
 */
const retryingUntilSignedOut = async <T>(
  attempt: () => Promise<T>,
  stopped: AbortSignal
): Promise<T> => {
  for (let tries = 0; ; tries += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one try at a time
      return await attempt();
    } catch (error) {
      if (
        stopped.aborted ||
        authErrors.codeOf(error) === "auth.unauthenticated"
      ) {
        throw error;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- waiting longer between tries
    await wait(
      untilSignedOutMs[Math.min(tries, untilSignedOutMs.length - 1)] ?? 0
    );
  }
};

/**
 * The pauses before following again once a follow ended by itself (its
 * connection dropped, or core let go of it): longer each time it ends
 * soon after it began, so no way a follow can end ever makes a tight
 * loop; back to the first once a follow lasted `steadyMs`. Each with full
 * jitter, so tabs that lost core together don't come back together.
 */
const followAgainMs = [0, 1000, 2000, 4000, 8000, 15_000] as const;

/** How long a follow must have lasted for its next end to start the pauses over. */
const steadyMs = 30_000;

/** What a follow's hold is: how it is let go of, and why core let go of it. */
type Hold = Pick<SubscriptionApi, "release" | "endedBy"> & Disposable;

/** Why core let go of `hold`, if it says; nothing when it can't be asked. */
const endedBy = async (hold: Hold | null): Promise<"displaced" | null> => {
  try {
    return (await hold?.endedBy()) ?? null;
  } catch {
    return null;
  }
};

/** Calls `back` once, the next time the page comes back to the front. */
const onceVisible = (back: () => void): void => {
  const visible = (): void => {
    if (document.visibilityState === "visible") {
      document.removeEventListener("visibilitychange", visible);
      back();
    }
  };
  document.addEventListener("visibilitychange", visible);
};

/**
 * Follows what `watch` subscribes to over `core`, until stopped. `watch`
 * gets `ended`, which its callback calls once core lets go of it (the
 * callback's `Symbol.dispose`). Followed again whenever it ends by itself:
 * the connection it was on dropped, or core let go of it (its object
 * gone, or more follows than core keeps), after a pause that grows while
 * it keeps ending soon (`followAgainMs`). One core let go of because the
 * person follows the same thing in more places than core keeps
 * (`displaced`) is followed again only once the page comes back to the
 * front: following again at once would only push out the person's next
 * oldest, which would do the same. `onFailed` gets why following stopped
 * for good, and whether that is because core has no such thing for the
 * person (`agent.chat_not_found`). Returns what stops it.
 */
export const follow = (
  core: CoreConnection,
  watch: (session: Session, ended: () => void) => Promise<Hold>,
  onFailed: (reason: string, gone: boolean) => void,
  {
    untilSignedOut = false,
    onDropped,
  }: {
    /**
     * Whether it is followed whatever fails, until the person's session
     * ends (the list of chats, which nothing reads again): every failure
     * tried again, ever less often, and a connection waited for as long
     * as it takes.
     */
    untilSignedOut?: boolean;
    /** It ended by itself: what the page has may be behind until it follows again. */
    onDropped?: () => void;
  } = {}
): (() => void) => {
  let closed = false;
  // Gives up waiting for a connection once following stops.
  const stopping = new AbortController();
  let release: (() => void) | undefined;
  /** Follows in a row that ended soon after they began. */
  let endedSoon = 0;
  const start = async (again: boolean): Promise<void> => {
    let current = true;
    /** The follow's hold, once it was made (none if it wasn't). */
    const held = Promise.withResolvers<Hold | null>();
    const startedAt = Date.now();
    /** It ended by itself: followed again, once, as the header says. */
    const ended = (): void => {
      if (!current || closed) {
        return;
      }
      current = false;
      onDropped?.();
      endedSoon = Date.now() - startedAt >= steadyMs ? 0 : endedSoon + 1;
      void (async () => {
        if ((await endedBy(await held.promise)) === "displaced") {
          onceVisible(() => {
            if (!closed) {
              void start(true);
            }
          });
          return;
        }
        const pause =
          followAgainMs[Math.min(endedSoon, followAgainMs.length - 1)] ?? 0;
        await wait(Math.random() * pause);
        if (!closed) {
          void start(true);
        }
      })();
    };
    const attempt = async () =>
      await core.withSession(
        async (session) => await watch(session, ended),
        again || untilSignedOut ? stopping.signal : undefined
      );
    try {
      const followed = untilSignedOut
        ? await retryingUntilSignedOut(attempt, stopping.signal)
        : await retrying(
            attempt,
            startRetryMs,
            // No connection came in its few seconds: say so, rather than
            // wait on, as a page does when core is out of reach. Stopped:
            // nothing more to try.
            (failure) =>
              !stopping.signal.aborted &&
              isTransient(failure) &&
              !(failure instanceof CoreTimeoutError)
          );
      held.resolve(followed);
      release = () => {
        current = false;
        void releaseQuietly(followed);
        followed[Symbol.dispose]();
      };
      if (closed) {
        release();
        return;
      }
      // The connection dropped: followed again on the next. Core answers
      // the follow with a stub.
      const stub: unknown = followed;
      if (stub instanceof RpcStub) {
        stub.onRpcBroken(ended);
      }
    } catch (error) {
      held.resolve(null);
      current = false;
      if (!closed) {
        onFailed(
          failureText(error),
          agentErrors.codeOf(error) === "agent.chat_not_found"
        );
      }
    }
  };
  void start(false);
  return () => {
    closed = true;
    stopping.abort();
    release?.();
  };
};

/**
 * Follows `chatId` over `core`: `onUpdate` gets every update, `onFailed`
 * why following stopped for good, and whether that is because core has no
 * such chat for the person (`gone`: deleted, or not theirs). Any other
 * refusal (too many pages following chats, say) leaves the chat theirs, and
 * only says why. After a drop it watches again after the last message the
 * page has. Returns what stops it.
 */
export const followChat = (
  core: CoreConnection,
  chatId: string,
  onUpdate: (update: ChatUpdate) => void,
  onFailed: (reason: string, gone: boolean) => void,
  /** The connection dropped: watched again, from the next update on. */
  onDropped?: () => void
): (() => void) => {
  let after: number | null = null;
  const received = (update: ChatUpdate): void => {
    const last = update.messages.at(-1);
    if (last !== undefined) {
      after = last.id;
    }
    onUpdate(update);
  };
  return follow(
    core,
    async (session, ended) =>
      await session.chats.watch(
        chatId,
        after,
        Object.assign(received, { [Symbol.dispose]: ended })
      ),
    onFailed,
    onDropped === undefined ? {} : { onDropped }
  );
};
