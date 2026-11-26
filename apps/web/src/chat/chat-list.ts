import type { ChatListUpdate, ChatSummary } from "@grasp-os/shared/chat";
import { useSyncExternalStore } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { useCore } from "../use-core.ts";
import { follow } from "./follow-chat.ts";

// The person's list of chats as core pushes it (`chats.watchList`): one
// watch per tab, whoever shows it (the sidebar's recent chats, the chats
// window), started with the first to show it and stopped a moment after
// the last. Core sends the whole list first, then each chat whose summary
// changed (made, renamed, asked in, answered, read, here or on another
// device) and those that left the list. The tab only applies that, in
// core's order, the most recently active first: nothing polls, and
// nothing is read again. After a dropped connection the watch starts
// again, and its first update, the whole list, replaces what the tab had.

/** The person's chats, as the tab follows them. */
export interface ChatList {
  /** Their chats in their list, the most recently active first. */
  chats: ChatSummary[];
  /** How many they archived. */
  archived: number;
  /** Whether core sent the list yet. */
  loaded: boolean;
  /** Why following stopped, if it did: the list stays as it was. */
  failure?: string;
}

const notLoaded: ChatList = { chats: [], archived: 0, loaded: false };

/** The most recently active first, as core lists them (`lastAt`). */
const newestFirst = (a: ChatSummary, b: ChatSummary): number =>
  Date.parse(b.lastAt) - Date.parse(a.lastAt);

/** `list` with `update` applied: the whole list, or each change and removal. */
export const applyListUpdate = (
  list: ChatList,
  update: ChatListUpdate
): ChatList => {
  const changed = new Set(update.chats.map(({ id }) => id));
  const removed = new Set(update.removed);
  const kept = update.full
    ? []
    : list.chats.filter(({ id }) => !changed.has(id) && !removed.has(id));
  return {
    chats: [...kept, ...update.chats].toSorted(newestFirst),
    archived: update.archived,
    loaded: true,
  };
};

interface Watch {
  core: CoreConnection;
  list: ChatList;
  listeners: Set<() => void>;
  stop: () => void;
}

/** The tab's one watch of the list, while anyone shows it. */
let watch: Watch | undefined;

const changed = (now: Watch, list: ChatList): void => {
  now.list = list;
  for (const listener of now.listeners) {
    listener();
  }
};

const start = (core: CoreConnection): Watch => {
  const started: Watch = {
    core,
    list: notLoaded,
    listeners: new Set(),
    stop: () => {
      // Replaced below, once following starts.
    },
  };
  started.stop = follow(
    core,
    async (session) =>
      await session.chats.watchList((update) => {
        changed(started, applyListUpdate(started.list, update));
      }),
    (failure) => {
      changed(started, { ...started.list, failure });
    }
  );
  return started;
};

/** One subscribe function per connection, so React keeps its subscription. */
const subscribers = new WeakMap<
  CoreConnection,
  (listener: () => void) => () => void
>();

const subscriberFor = (
  core: CoreConnection
): ((listener: () => void) => () => void) => {
  let subscriber = subscribers.get(core);
  if (subscriber === undefined) {
    subscriber = (listener) => {
      if (watch?.core !== core) {
        watch?.stop();
        watch = start(core);
      }
      const followed = watch;
      followed.listeners.add(listener);
      return () => {
        followed.listeners.delete(listener);
        // Stopped a moment later, so whoever shows the list next (the
        // window after the sidebar, React subscribing again) keeps it.
        setTimeout(() => {
          if (followed.listeners.size === 0 && watch === followed) {
            followed.stop();
            watch = undefined;
          }
        }, 0);
      };
    };
    subscribers.set(core, subscriber);
  }
  return subscriber;
};

/** Follows nothing, for someone who may not chat. */
const followNothing = (): (() => void) => () => {
  // Nothing was followed, so there is nothing to stop.
};

/**
 * The person's chats, as core pushes them; nothing while `enabled` is
 * false (Grasp staff in the onboarding alone, whom core refuses chats).
 */
export const useChatList = (enabled = true): ChatList => {
  const core = useCore();
  return useSyncExternalStore(
    enabled ? subscriberFor(core) : followNothing,
    () => (enabled && watch?.core === core ? watch.list : notLoaded)
  );
};
