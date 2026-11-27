import { useSyncExternalStore } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { useCore } from "../use-core.ts";
import { applyUpdate, emptyView, followChat } from "./follow-chat.ts";
import type { ChatView } from "./follow-chat.ts";

// One watch per chat per tab, whoever shows it: the chat page and the chat
// dock on every other page read the same chat from the same watch
// (`followChat`), which starts with the first to show it and stops with
// the last.

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
}

interface Watch {
  state: FollowedChat;
  listeners: Set<() => void>;
  /** Stops following it; set once following has started. */
  stop?: () => void;
}

const watches = new Map<string, Watch>();

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
 * One subscribe function per chat (and connection), so React keeps its
 * subscription from render to render rather than letting go and taking it
 * again; let go of with the watch.
 */
const subscribers = new WeakMap<
  CoreConnection,
  Map<string, (listener: () => void) => () => void>
>();

/** Shows `chatId` to `listener`, starting its watch if nobody else shows it. */
const subscribe = (
  core: CoreConnection,
  chatId: string,
  listener: () => void
): (() => void) => {
  let watch = watches.get(chatId);
  if (watch === undefined) {
    const started: Watch = {
      state: notStarted,
      listeners: new Set(),
    };
    watches.set(chatId, started);
    started.stop = followChat(
      core,
      chatId,
      (update) => {
        changed(started, {
          ...started.state,
          view: applyUpdate(started.state.view, update),
        });
      },
      (failure, gone) => {
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
        subscribers.get(core)?.delete(chatId);
      }
    }, 0);
  };
};

const subscriberFor = (
  core: CoreConnection,
  chatId: string
): ((listener: () => void) => () => void) => {
  const ofCore =
    subscribers.get(core) ??
    new Map<string, (listener: () => void) => () => void>();
  subscribers.set(core, ofCore);
  let subscriber = ofCore.get(chatId);
  if (subscriber === undefined) {
    subscriber = (listener) => subscribe(core, chatId, listener);
    ofCore.set(chatId, subscriber);
  }
  return subscriber;
};

/** Follows nothing: there is no chat yet. */
const followNothing = (): (() => void) => () => {
  // Nothing was followed, so there is nothing to stop.
};

/** `chatId` as the tab follows it, as it streams; nothing without one. */
export const useFollowedChat = (chatId: string | undefined): FollowedChat => {
  const core = useCore();
  return useSyncExternalStore(
    chatId === undefined ? followNothing : subscriberFor(core, chatId),
    () =>
      chatId === undefined
        ? notStarted
        : (watches.get(chatId)?.state ?? notStarted)
  );
};
