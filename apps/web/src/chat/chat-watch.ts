import type { ChatMessage } from "@grasp-os/shared/chat";
import { useRouteContext } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { useCore } from "../use-core.ts";
import { chatMade, startOf, whenTried } from "./chat-starts.ts";
import {
  applyUpdate,
  emptyView,
  followChat,
  withOlder,
} from "./follow-chat.ts";
import type { ChatView } from "./follow-chat.ts";
import type { ThreadOlder } from "./thread.tsx";

// One watch per chat per tab, whoever shows it: the chat page and the chat
// dock on every other page read the same chat from the same watch
// (`followChat`), which starts with the first to show it and stops with
// the last. The last view of a chat nobody shows any more is kept for the
// tab, the newest few, by person: shown again at once when the chat is,
// while its watch starts again, whose first update replaces it whole
// (the chat's messages as core has them now, a rating or an erased
// result's stand-in too). Forgotten with the person's other chats when
// they sign out (active-chat.ts).

/** A chat as the tab follows it, and why following it stopped, if it did. */
export interface FollowedChat {
  view: ChatView;
  failure: string | undefined;
  /**
   * Whether core has no such chat for the person (deleted, or not
   * theirs), not merely out of reach or refusing for now: only once
   * following stopped.
   */
  gone?: boolean;
  /** Whether an older page is being read now (`readOlder`). */
  readingOlder?: boolean;
  /** Whether the last read of an older page failed: pressed again, it goes again. */
  olderFailed?: boolean;
}

interface Watch {
  core: CoreConnection;
  state: FollowedChat;
  listeners: Set<() => void>;
  /** The read of an older page under way (`readOlder`), if one is. */
  older?: Promise<void>;
  /** Stops following it; set once following has started. */
  stop?: () => void;
  /** Whether its view is a kept one, which the first update replaces. */
  kept: boolean;
}

const watches = new Map<string, Watch>();

/** How many chats' last views the tab keeps. */
const keptViews = 20;

/**
 * The last view of each chat nobody shows now, by person and chat, the
 * newest last: as it is shown again, stale (`ChatView.stale`), with no
 * word of where the person had read to, which only core may say.
 */
const kept = new Map<string, FollowedChat>();

const keptKey = (userId: string, chatId: string): string =>
  JSON.stringify([userId, chatId]);

/** Keeps `view` as the last of its chat, the oldest kept let go past the most. */
const keep = (key: string, view: ChatView): void => {
  kept.delete(key);
  kept.set(key, {
    view: { ...view, seenUpTo: undefined, stale: true },
    failure: undefined,
  });
  for (const oldest of kept.keys()) {
    if (kept.size <= keptViews) {
      break;
    }
    kept.delete(oldest);
  }
};

/**
 * Counts each time the kept views were forgotten: a watch shown before
 * keeps nothing as it stops after.
 */
let forgotten = 0;

/** Forgets every chat's kept view: the person signed out. */
export const forgetKeptViews = (): void => {
  kept.clear();
  forgotten += 1;
};

const notStarted: FollowedChat = { view: emptyView, failure: undefined };

const changed = (watch: Watch, state: FollowedChat): void => {
  watch.state = state;
  for (const listener of watch.listeners) {
    listener();
  }
};

/**
 * The person read chat `chatId` up to message `id` (`markRead`, from any
 * view of it): the tab's watch of it says so from now on, so another view
 * of it opened after (the dock after the page) draws no New line over what
 * was read meanwhile.
 */
export const readTo = (chatId: string, id: number): void => {
  const watch = watches.get(chatId);
  const { view } = watch?.state ?? notStarted;
  if (watch !== undefined && view.loaded && (view.seenUpTo ?? 0) < id) {
    changed(watch, { ...watch.state, view: { ...view, seenUpTo: id } });
  }
};

/**
 * Reads the page of chat `chatId` before the first message the tab has of
 * it (`ChatsApi.history`) into its watch's view, one read at a time: what
 * the thread asks for as the person scrolls back. Resolves once it is in,
 * or failed (`olderFailed`); nothing while the chat isn't shown, or has
 * nothing older.
 */
export const readOlder = async (chatId: string): Promise<void> => {
  const watch = watches.get(chatId);
  if (watch === undefined) {
    return;
  }
  const reading = watch.older;
  if (reading !== undefined) {
    await reading;
    return;
  }
  const { view } = watch.state;
  const before = view.messages[0]?.id;
  if (!view.loaded || !view.older || before === undefined) {
    return;
  }
  const read = async (): Promise<void> => {
    changed(watch, { ...watch.state, readingOlder: true, olderFailed: false });
    try {
      const page = await watch.core.withSession(
        async (session) => await session.chats.history(chatId, before)
      );
      changed(watch, {
        ...watch.state,
        view: withOlder(watch.state.view, before, page),
        readingOlder: false,
      });
    } catch {
      changed(watch, {
        ...watch.state,
        readingOlder: false,
        olderFailed: true,
      });
    } finally {
      watch.older = undefined;
    }
  };
  watch.older = read();
  await watch.older;
};

/**
 * Chat `chatId` whole, as a copy or an export of it needs: the tab's view
 * of it, its earlier pages read before it (`ChatsApi.history`), never put
 * into the view the thread draws, which keeps only what the person read
 * back to. None when a read failed or the chat isn't shown.
 */
export const readWhole = async (
  chatId: string
): Promise<ChatView | undefined> => {
  const watch = watches.get(chatId);
  if (watch === undefined) {
    return undefined;
  }
  const { view } = watch.state;
  // Each page read, the latest first: the oldest last.
  const pages: (readonly ChatMessage[])[] = [view.messages];
  let { older } = view;
  try {
    for (let before = view.messages[0]?.id; older && before !== undefined;) {
      const upTo = before;
      // oxlint-disable-next-line no-await-in-loop -- a page at a time, each before the last
      const page = await watch.core.withSession(
        async (session) => await session.chats.history(chatId, upTo)
      );
      const earlier = page.messages.filter(({ id }) => id < upTo);
      pages.push(earlier);
      ({ older } = page);
      before = earlier[0]?.id;
    }
  } catch {
    return undefined;
  }
  return { ...view, messages: pages.toReversed().flat(), older: false };
};

/**
 * One subscribe function per chat (and connection), so React keeps its
 * subscription from render to render rather than letting go and taking it
 * again; let go of with the watch.
 */
const subscribers = new WeakMap<
  CoreConnection,
  Map<string, (listener: () => void) => () => void>
>();

/**
 * Shows `chatId` to `listener`, starting its watch if nobody else shows it:
 * from its kept view, if the tab has one of `userId`'s.
 */
const subscribe = (
  core: CoreConnection,
  userId: string,
  chatId: string,
  listener: () => void
): (() => void) => {
  const key = keptKey(userId, chatId);
  const since = forgotten;
  let watch = watches.get(chatId);
  if (watch === undefined) {
    const last = kept.get(key);
    const started: Watch = {
      core,
      state: last ?? notStarted,
      listeners: new Set(),
      kept: last !== undefined,
    };
    watches.set(chatId, started);
    const begin = (): void => {
      started.stop = followChat(
        core,
        chatId,
        (update) => {
          // Followed: the chat is there, whoever made it.
          chatMade(chatId);
          // The first update holds the whole chat: it replaces a kept view.
          const from = started.kept ? emptyView : started.state.view;
          started.kept = false;
          changed(started, {
            ...started.state,
            view: applyUpdate(from, update),
          });
        },
        (failure, gone) => {
          // A chat this tab is starting isn't made yet: looked for again
          // once its question is done, taken or not.
          if (gone && startOf(chatId) !== undefined) {
            started.stop = whenTried(chatId, begin);
            return;
          }
          changed(started, { ...started.state, failure, gone });
        },
        // Behind until the watch answers again (`applyUpdate` clears it).
        () => {
          changed(started, {
            ...started.state,
            view: { ...started.state.view, resuming: true },
          });
        }
      );
    };
    begin();
    watch = started;
  }
  const followed = watch;
  followed.listeners.add(listener);
  return () => {
    followed.listeners.delete(listener);
    // Stopped a moment later, so whoever shows the chat next (the chat
    // page after the dock, React subscribing again) keeps the same watch.
    setTimeout(() => {
      if (followed.listeners.size === 0 && watches.get(chatId) === followed) {
        followed.stop?.();
        watches.delete(chatId);
        subscribers.get(core)?.delete(key);
        const { view, failure } = followed.state;
        if (view.loaded && failure === undefined && since === forgotten) {
          keep(key, view);
        }
      }
    }, 0);
  };
};

const subscriberFor = (
  core: CoreConnection,
  userId: string,
  chatId: string
): ((listener: () => void) => () => void) => {
  const ofCore =
    subscribers.get(core) ??
    new Map<string, (listener: () => void) => () => void>();
  subscribers.set(core, ofCore);
  const key = keptKey(userId, chatId);
  let subscriber = ofCore.get(key);
  if (subscriber === undefined) {
    subscriber = (listener) => subscribe(core, userId, chatId, listener);
    ofCore.set(key, subscriber);
  }
  return subscriber;
};

/** Follows nothing: there is no chat yet. */
const followNothing = (): (() => void) => () => {
  // Nothing was followed, so there is nothing to stop.
};

/**
 * `chatId` as the tab follows it, as it streams, from its kept view while
 * its watch starts again; nothing without one.
 */
export const useFollowedChat = (chatId: string | undefined): FollowedChat => {
  const core = useCore();
  // Whose views are kept: the signed-in person's, under the shell.
  const { identity } = useRouteContext({ strict: false });
  return useSyncExternalStore(
    chatId === undefined
      ? followNothing
      : subscriberFor(core, identity?.userId ?? "", chatId),
    () =>
      chatId === undefined
        ? notStarted
        : (watches.get(chatId)?.state ??
          kept.get(keptKey(identity?.userId ?? "", chatId)) ??
          notStarted)
  );
};

/**
 * What chat `chatId`'s thread needs of its earlier messages, while the tab
 * hasn't read them all (`ChatView.older`, `readOlder`); none else.
 */
export const useOlder = (
  chatId: string | undefined
): ThreadOlder | undefined => {
  const { view, readingOlder, olderFailed } = useFollowedChat(chatId);
  return chatId === undefined || !view.older
    ? undefined
    : {
        reading: readingOlder === true,
        failed: olderFailed === true,
        onRead: () => {
          void readOlder(chatId);
        },
      };
};
