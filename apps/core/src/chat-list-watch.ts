import type { ChatListUpdate, ChatSummary } from "@grasp-os/shared/chat";

import { Pushes } from "./pushes.ts";
import type { Listener } from "./pushes.ts";

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
  /** The person whose list it follows. */
  readonly personId: string;
  /** The list as it was last told: what the next update goes out from. */
  #list: ChatList = { chats: [], archived: 0 };
  /** Each chat as this watcher was sent it, by ID; none before the first update. */
  #sent: Map<string, string> | undefined;
  #archivedSent = 0;

  constructor(
    listener: Listener<ChatListUpdate>,
    personId: string,
    drop: () => void
  ) {
    this.#pushes = new Pushes(listener, () => this.#next(), drop);
    this.personId = personId;
  }

  /**
   * The list as it is now, read once for every watcher of it: what of it
   * changed goes out, now or after the update on its way.
   */
  push(list: ChatList): void {
    this.#list = list;
    this.#pushes.changed();
  }

  #next(): ChatListUpdate | undefined {
    const { chats, archived } = this.#list;
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
