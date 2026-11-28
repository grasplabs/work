import type { ChatListUpdate } from "@grasp-os/shared/chat";

import { ChatListWatch } from "./chat-list-watch.ts";
import type { ChatList } from "./chat-list-watch.ts";
import { Pushes } from "./pushes.ts";
import type { Listener } from "./pushes.ts";

/** Where a follower the old way gets its updates: core's callback, through RPC. */
export type ChatListListener = Rpc.Stub<
  (update: ChatListUpdate) => Promise<void>
>;

/**
 * A follower of the list the old way (`Workspace.watchChats`), its callback
 * kept in memory: only while core's Worker of the release before this one
 * may still follow so during a deploy. One update at a time, changes
 * meanwhile merged into the next (`Pushes`). Removed in the release after.
 */
export class OldWayListWatch {
  readonly #pushes: Pushes<ChatListUpdate>;
  readonly #sent = new ChatListWatch();
  #list: ChatList = { chats: [], archived: 0 };

  constructor(listener: Listener<ChatListUpdate>, drop: () => void) {
    this.#pushes = new Pushes(
      listener,
      () => this.#sent.next(this.#list),
      drop
    );
  }

  /** The list as it is now: what changed of it goes out. */
  push(list: ChatList): void {
    this.#list = list;
    this.#pushes.changed();
  }

  [Symbol.dispose](): void {
    this.#pushes[Symbol.dispose]();
  }
}
