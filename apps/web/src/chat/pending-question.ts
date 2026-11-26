import type { ChatMessage, ChatSummary } from "@grasp-os/shared/chat";
import { useSyncExternalStore } from "react";

import type { BoxMention } from "./mentions.tsx";

// The question on its way to core, shown in the thread the moment it is
// sent (as T3 Code and the AI SDK's `sendMessage` add the person's message
// before the request goes): the box empties at once, and the thread draws
// the question as its own until core's copy comes. A question that fails
// to send leaves the thread and goes back into the box, its words, what
// they mention and its files, where the box says why, as T3 Code puts a
// failed message back into its composer. Kept for the page, by chat (or
// the slot's next chat, before core made one), so the chat's page shows
// the question Chat's start sent, and its box takes it back if it fails.

/** A file the question carries, as the box held it. */
export interface PendingFile {
  id: string;
  file: File;
}

/** A question on its way, or one that failed to send. */
export interface PendingQuestion {
  text: string;
  mentions: readonly BoxMention[];
  files: readonly PendingFile[];
  /**
   * The chat's last message when it was sent: the first question after it
   * is core's copy of this one.
   */
  after: number;
  /** When it was sent, as this browser's clock says. */
  at: string;
  /** It didn't go: the box takes it back. */
  failed: boolean;
}

/** Where a chat's question is kept: by the chat, or the slot's next one. */
export const pendingKey = (chatId: string | undefined, slot: string): string =>
  chatId ?? `new.${slot}`;

const pending = new Map<string, PendingQuestion>();

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Sets, or with none clears, the question kept at `key`. */
export const setPending = (
  key: string,
  question: PendingQuestion | undefined
): void => {
  if (question === undefined) {
    pending.delete(key);
  } else {
    pending.set(key, question);
  }
  for (const listener of listeners) {
    listener();
  }
};

/** The question kept at `key`, if any. */
export const pendingAt = (key: string): PendingQuestion | undefined =>
  pending.get(key);

/** The question on its way in, or failed to send to, the chat at `key`. */
export const usePending = (key: string): PendingQuestion | undefined =>
  useSyncExternalStore(subscribe, () => pending.get(key));

/**
 * The question to draw in a chat of `messages`: one on its way, until core's
 * copy of it (the first question after it) is there.
 */
export const shownPending = (
  question: PendingQuestion | undefined,
  messages: readonly ChatMessage[]
): PendingQuestion | undefined =>
  question === undefined ||
  question.failed ||
  messages.some(({ id, role }) => role === "user" && id > question.after)
    ? undefined
    : question;

/** The chats a question here just made, until their page opens. */
const made = new Map<string, ChatSummary>();

/** Keeps `chat`, which a question just made, for its page to open with. */
export const keepMade = (chat: ChatSummary): void => {
  made.set(chat.id, chat);
};

/**
 * The chat a question just made, as core gave it, once: its page opens
 * with it at once rather than reading it again (routes/_shell.chats.$chatId.tsx).
 */
export const takeMade = (chatId: string): ChatSummary | undefined => {
  const chat = made.get(chatId);
  made.delete(chatId);
  return chat;
};
