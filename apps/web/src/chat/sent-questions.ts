import type { ChatMessage } from "@grasp-os/shared/chat";
import { useSyncExternalStore } from "react";

// The questions the person sent from this tab that core hasn't shown back
// yet, by chat: the thread draws each the moment Send is pressed, under
// the key it goes with (`ChatQuestion.key`), and core's copy, which comes
// back with that key, takes its place under the same key, so it never
// moves or draws again. One core refused stays, said not sent, with Try
// again. Kept for the tab, across pages (a new chat's first question is
// sent from Chat's start, and shows on the chat's page); forgotten with
// the person's other chats when they sign out (active-chat.ts), as AI
// SDK's `useChat` and T3 Code keep a sent message until the server's
// copy replaces it.

/** A question sent from this tab, as the thread draws it until core shows it. */
export interface SentQuestion {
  /** The key it went with, which core's copy comes back with. */
  key: string;
  text: string;
  /** When it was sent (ISO 8601). */
  at: string;
  /** Why core didn't take it, once it refused; none while on its way. */
  failure?: string;
}

const noQuestions: readonly SentQuestion[] = [];

let sent = new Map<string, readonly SentQuestion[]>();

const listeners = new Set<() => void>();

const changed = (next: Map<string, readonly SentQuestion[]>): void => {
  sent = next;
  for (const listener of listeners) {
    listener();
  }
};

/** `question` sent in `chatId`: drawn at once, or again as it goes once more. */
export const questionSent = (chatId: string, question: SentQuestion): void => {
  const others = (sent.get(chatId) ?? noQuestions).filter(
    ({ key }) => key !== question.key
  );
  changed(new Map(sent).set(chatId, [...others, question]));
};

/** Core refused question `key` in `chatId`: it stays, said not sent. */
export const questionRefused = (
  chatId: string,
  key: string,
  failure: string
): void => {
  const questions = sent.get(chatId) ?? noQuestions;
  changed(
    new Map(sent).set(
      chatId,
      questions.map((question) =>
        question.key === key ? { ...question, failure } : question
      )
    )
  );
};

/**
 * The chat's turn ended: whatever of its questions core took is in its
 * messages by now, with its key or, should its object have restarted
 * before keeping the key, without: only the ones it refused stay.
 */
export const turnEnded = (chatId: string): void => {
  const questions = sent.get(chatId);
  if (questions?.some(({ failure }) => failure === undefined) === true) {
    changed(
      new Map(sent).set(
        chatId,
        questions.filter(({ failure }) => failure !== undefined)
      )
    );
  }
};

/** Forgets every question sent: the person signed out. */
export const forgetSentQuestions = (): void => {
  changed(new Map());
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The questions sent in `chatId` from this tab that `messages`, the chat
 * as core shows it, doesn't hold yet: matched by their key alone.
 */
export const useSentQuestions = (
  chatId: string | undefined,
  messages: readonly ChatMessage[]
): readonly SentQuestion[] => {
  const all = useSyncExternalStore(subscribe, () =>
    chatId === undefined ? noQuestions : (sent.get(chatId) ?? noQuestions)
  );
  if (all.length === 0) {
    return noQuestions;
  }
  const shown = new Set(
    messages.flatMap((message) =>
      message.role === "user" && message.key !== undefined ? [message.key] : []
    )
  );
  return all.filter(({ key }) => !shown.has(key));
};
