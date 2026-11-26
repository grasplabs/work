import type { ChatListUpdate, ChatSummary } from "@grasp-os/shared/chat";

import { Pushes } from "./pushes.ts";

/** Where a watcher of a person's list of chats gets its updates. */
export type ChatListListener = Rpc.Stub<
  (update: ChatListUpdate) => Promise<void>
>;

/** The person's list as it is now: what `chats` gives, and how many they archived. */
export interface ChatList {
  chats: ChatSummary[];
  archived: number;
}

/**
 * One watcher of a person's list of chats (the Workspace object's
 * `watchChats`): the whole list first, then each chat whose summary
 * changed since the last update and those that left the list, against
 * what this watcher was sent. Told of every change that may move the list
 * (a message stored, a turn starting or ending, a read, a rename), it sends
 * nothing when none of what it shows changed, and changes that come while
 * an update is on its way go out together (`Pushes`).
 */
export class ChatListWatch {
  readonly #pushes: Pushes<ChatListUpdate>;
  readonly #list: () => ChatList;
  /** Each chat as this watcher was sent it, by ID; none before the first update. */
  #sent: Map<string, string> | undefined;
  #archivedSent = 0;

  constructor(
    listener: ChatListListener,
    list: () => ChatList,
    drop: () => void
  ) {
    this.#pushes = new Pushes(listener, () => this.#next(), drop);
    this.#list = list;
  }

  /** The list may have changed: what did goes out. */
  push(): void {
    this.#pushes.changed();
  }

  #next(): ChatListUpdate | undefined {
    const { chats, archived } = this.#list();
    const now = new Map(chats.map((chat) => [chat.id, JSON.stringify(chat)]));
    const sent = this.#sent;
    this.#sent = now;
    const archivedChanged = archived !== this.#archivedSent;
    this.#archivedSent = archived;
    if (sent === undefined) {
      return { chats, removed: [], full: true, archived };
    }
    const changed = chats.filter(({ id }) => sent.get(id) !== now.get(id));
    const removed = [...sent.keys()].filter((id) => !now.has(id));
    if (changed.length === 0 && removed.length === 0 && !archivedChanged) {
      return undefined;
    }
    return { chats: changed, removed, full: false, archived };
  }

  [Symbol.dispose](): void {
    this.#pushes[Symbol.dispose]();
  }
}
