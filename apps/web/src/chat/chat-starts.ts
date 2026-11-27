import type { ChatStart } from "@grasp-os/shared/chat";

// The chats this tab named and is starting (`ChatStart`), as T3 Code and
// the AI SDK's chat template name a new thread in the browser: its first
// question makes it, so its page opens, and shows the question, at once.
// Each is kept until the tab knows core made it (the question taken, or
// the chat followed): until then a question asked in it again goes with
// the same start, which core makes once; its page shows it, not "not
// found"; and its watch, refused while there is no such chat, starts
// again once it is made.

const starts = new Map<string, ChatStart>();

/** Told when a chat started here is made, by its ID. */
const waiting = new Map<string, Set<() => void>>();

/** The start of chat `chatId`, while the tab is still starting it. */
export const startOf = (chatId: string | undefined): ChatStart | undefined =>
  chatId === undefined ? undefined : starts.get(chatId);

/** Keeps that the tab is starting chat `chatId` with `start`. */
export const starting = (chatId: string, start: ChatStart): void => {
  starts.set(chatId, start);
};

/** Chat `chatId` is made: whoever waited for it is told, once. */
export const chatMade = (chatId: string): void => {
  starts.delete(chatId);
  const told = waiting.get(chatId);
  waiting.delete(chatId);
  for (const listener of told ?? []) {
    listener();
  }
};

/** Has `listener` told once chat `chatId` is made; answers what stops waiting. */
export const whenMade = (
  chatId: string,
  listener: () => void
): (() => void) => {
  const listeners = waiting.get(chatId) ?? new Set<() => void>();
  listeners.add(listener);
  waiting.set(chatId, listeners);
  return () => {
    listeners.delete(listener);
  };
};
