import type { ChatMessage } from "@grasp-os/shared/chat";
import { useSyncExternalStore } from "react";

import type { BoxMention } from "./mentions.tsx";
import type { BoxFile } from "./use-ask.ts";

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
  /** The files it carries, and whom it mentions: sent again with it. */
  files: readonly BoxFile[];
  mentions: readonly BoxMention[];
}

const noQuestions: readonly SentQuestion[] = [];

let sent = new Map<string, readonly SentQuestion[]>();

/** The keys of the questions on their way to core now, by chat. */
const sending = new Map<string, Set<string>>();

/**
 * Whether a question is on its way in `chatId`, from any box of this tab
 * (Chat's start's, which the chat's page follows): the next waits for it,
 * so none overtakes it.
 */
export const isSending = (chatId: string): boolean =>
  (sending.get(chatId)?.size ?? 0) > 0;

/** Question `key` set out for core in `chatId`. */
export const sendBegan = (chatId: string, key: string): void => {
  sending.set(chatId, new Set(sending.get(chatId)).add(key));
};

/** Question `key` reached core in `chatId`, or was refused. */
export const sendEnded = (chatId: string, key: string): void => {
  sending.get(chatId)?.delete(key);
};

const listeners = new Set<() => void>();

const changed = (next: Map<string, readonly SentQuestion[]>): void => {
  sent = next;
  for (const listener of listeners) {
    listener();
  }
};

/**
 * `question` sent in `chatId`: drawn at once, or again as it goes once
 * more. One core refused before it goes: the person moved on from it.
 */
export const questionSent = (chatId: string, question: SentQuestion): void => {
  const others = (sent.get(chatId) ?? noQuestions).filter(
    ({ key, failure }) => key !== question.key && failure === undefined
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
 * before keeping the key, without. The ones it refused stay, and so do
 * those still on their way (sent again while another answer ended).
 */
export const turnEnded = (chatId: string): void => {
  const questions = sent.get(chatId) ?? noQuestions;
  const onTheirWay = sending.get(chatId);
  const kept = questions.filter(
    ({ key, failure }) => failure !== undefined || onTheirWay?.has(key) === true
  );
  if (kept.length !== questions.length) {
    changed(new Map(sent).set(chatId, kept));
  }
};

/** Forgets every question sent: the person signed out. */
export const forgetSentQuestions = (): void => {
  sending.clear();
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
