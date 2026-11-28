import type { ChatListUpdate, ChatSummary } from "@grasp-os/shared/chat";

/** The person's list as it is now: what `chats` gives, and how many they archived. */
export interface ChatList {
  chats: ChatSummary[];
  archived: number;
}

/**
 * What one follower of a person's list of chats was sent (their object
 * keeps one per follower's socket, person-connections.ts): the whole list
 * first, then each chat whose summary changed since and those that left
 * the list. Nothing when none of what it shows changed. Kept in memory
 * only: an object that slept or reset has none for a socket, and sends it
 * the whole list again, which the page puts in place of its own.
 */
export class ChatListWatch {
  /** Each chat as the follower was sent it, by ID; none before the first update. */
  #sent: Map<string, string> | undefined;
  #archivedSent = 0;

  /** What `list` changes for this follower; undefined when nothing it shows did. */
  next({ chats, archived }: ChatList): ChatListUpdate | undefined {
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
}
