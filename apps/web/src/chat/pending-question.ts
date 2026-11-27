import type { ChatMessage, ChatQueued } from "@grasp-os/shared/chat";
import { useEffect, useId, useSyncExternalStore } from "react";

import type { BoxMention } from "./mentions.tsx";

// The question on its way to core, shown in the thread the moment it is
// sent (as T3 Code and the AI SDK's `sendMessage` add the person's message
// before the request goes): the box empties at once, and the thread draws
// the question as its own until core's copy comes. A question from the box
// that fails to send leaves the thread and goes back into the box, its
// words, what they mention and its files, with why, as T3 Code puts a
// failed message back into its composer. Kept for the page, by chat (or
// the slot's next chat, before core made one), so the chat's page shows
// the question Chat's start sent as it opened that page, and takes it back
// if it fails once Chat's start is gone.

/** A file the question carries, as the box held it. */
export interface PendingFile {
  id: string;
  file: File;
}

/** Where a question on its way stands. */
export type PendingState = "sending" | "sent" | { failed: string };

/** A question on its way, taken by core, or refused. */
export interface PendingQuestion {
  text: string;
  mentions: readonly BoxMention[];
  files: readonly PendingFile[];
  /** When it was sent, as this browser's clock says. */
  at: string;
  /**
   * Sent while the agent answered: core queues it behind that answer
   * (`ChatUpdate.queued`), so it is drawn as queued, not answered yet.
   */
  queues: boolean;
  /**
   * How many questions in its words were queued already when it was sent:
   * core's copy is one more.
   */
  alreadyQueued: number;
  /** The key it went with (`ChatQuestion.key`): the same question again goes with it. */
  key: string;
  /**
   * The box that sent it: only that box takes it back if it fails, or,
   * once that box is gone, the one that shows its chat.
   */
  owner: string;
  /**
   * Whether the person sent it from the box: a question asked for them
   * (Try again, "Carry on.") isn't put into the box if it fails.
   */
  fromBox: boolean;
  /** On its way, taken by core, or refused, and why. */
  state: PendingState;
}

/** Where a chat's question is kept: by the chat, or the slot's next one. */
export const pendingKey = (chatId: string | undefined, slot: string): string =>
  chatId ?? `new.${slot}`;

const pending = new Map<string, PendingQuestion>();

/** The boxes on the page now, by their owner ID. */
const boxes = new Set<string>();

const listeners = new Set<() => void>();

const told = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

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
  told();
};

/** Clears `question` from `key`, unless another took its place since. */
export const clearPending = (key: string, question: PendingQuestion): void => {
  if (pending.get(key) === question) {
    setPending(key, undefined);
  }
};

/** The question kept at `key`, as it stands now. */
export const pendingAt = (key: string): PendingQuestion | undefined =>
  pending.get(key);

/** The question on its way in, or failed to send to, the chat at `key`. */
export const usePending = (key: string): PendingQuestion | undefined =>
  useSyncExternalStore(subscribe, () => pending.get(key));

/**
 * The calling box's owner ID, known to be on the page while it is: once it
 * is gone, the box that shows its chat takes back what it sent.
 */
export const useBoxOwner = (): string => {
  const owner = useId();
  useEffect(() => {
    boxes.add(owner);
    told();
    return () => {
      boxes.delete(owner);
      told();
    };
  }, [owner]);
  return owner;
};

/**
 * Whether the box `owner` takes `question` back: a failed one from a box,
 * by the box that sent it, or by any that shows its chat once that one is
 * gone.
 */
export const takesBack = (
  question: PendingQuestion | undefined,
  owner: string
): question is PendingQuestion & { state: { failed: string } } =>
  question !== undefined &&
  question.fromBox &&
  typeof question.state === "object" &&
  (question.owner === owner || !boxes.has(question.owner));

/**
 * Whether core has its own copy of `question`: queued behind the answer
 * being written, in its words, or in `messages`, with the key it went with
 * (`ChatMessage.key`), never another question that came meanwhile (an
 * older one queued, now taken). Core keeps the key in the question's own
 * entry, so its copy has it whatever restarted on the way.
 */
export const taken = (
  question: PendingQuestion,
  messages: readonly ChatMessage[],
  queued: readonly ChatQueued[] = []
): boolean => {
  const { key, text } = question;
  if (
    queued.filter((each) => each.text === text).length > question.alreadyQueued
  ) {
    return true;
  }
  return messages.some(
    (message) => message.role === "user" && message.key === key
  );
};

/**
 * The question to draw in a chat of `messages` and `queued`: one on its
 * way, or taken, until core's copy of it is there, so it is drawn once.
 */
export const shownPending = (
  question: PendingQuestion | undefined,
  messages: readonly ChatMessage[],
  queued: readonly ChatQueued[] = []
): PendingQuestion | undefined =>
  question === undefined ||
  typeof question.state === "object" ||
  taken(question, messages, queued)
    ? undefined
    : question;
