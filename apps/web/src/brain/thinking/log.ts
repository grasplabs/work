import type { ChatMessage } from "@grasp-os/shared/chat";
import { useSyncExternalStore } from "react";

import { thinkingIn } from "./play.ts";

// What this tab saw of Grasp's thinking (grasplabs/prototype
// `data/brain-thinking.ts`, its logic alone): when each step reached it, so
// it plays as it comes; the answers whose picture the person put away; and
// what the thinking found, a link between the teams that said the same,
// which grows in as a new nerve once the picture is put away and stays for
// the tab. Nothing of it is kept in the browser: the steps are core's, kept
// with the answer. Apart from how the brain draws it (use-thinking.ts), so
// the chat thread on every page reads it without loading any of that.

/** A link the thinking taught the brain: between two teams, from when it grows in. */
export interface Learned {
  id: string;
  from: string;
  to: string;
  at: number;
}

/** What the tab saw of Grasp's thinking; a new one whenever any of it changes. */
export interface ThinkingLog {
  /** When each step reached the tab, by its call. */
  arrived: ReadonlyMap<string, number>;
  /** The questions whose picture the person put away. */
  putAway: ReadonlySet<number>;
  learned: readonly Learned[];
}

const empty: ThinkingLog = {
  arrived: new Map(),
  putAway: new Set(),
  learned: [],
};

let log = empty;
const listeners = new Set<() => void>();

const change = (next: Partial<ThinkingLog>): void => {
  log = { ...log, ...next };
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

/** How long after the picture is put away what it found sets off growing: once the brain is there to see it. */
const GROW_AFTER_MS = 900;

/**
 * The steps of a chat that reached this tab while Grasp answers
 * (`running`): when each first did, so it plays as it comes. Steps read
 * with an answer already done never play by themselves.
 */
export const noteArrivals = (
  messages: readonly ChatMessage[],
  running: boolean
): void => {
  if (!running) {
    return;
  }
  const now = Date.now();
  const fresh = (thinkingIn(messages).at(-1)?.calls ?? []).filter(
    (call) => !log.arrived.has(call)
  );
  if (fresh.length > 0) {
    change({
      arrived: new Map([
        ...log.arrived,
        ...fresh.map((call): [string, number] => [call, now]),
      ]),
    });
  }
};

/** The calls whose findings were taught to the brain already. */
const taught = new Set<string>();

/** Whether call `call`'s finding is still to teach the brain; it is taught from now. */
export const teachOnce = (call: string): boolean => {
  if (taught.has(call)) {
    return false;
  }
  taught.add(call);
  return true;
};

/** What the thinking taught the brain, added to what it taught before. */
export const learn = (lessons: readonly Learned[]): void => {
  if (lessons.length > 0) {
    change({ learned: [...log.learned, ...lessons] });
  }
};

/**
 * The person put a question's picture away: the brain is itself again,
 * and what the thinking found grows in now, where they are about to see it.
 */
export const putThinkingAway = (
  questionId: number,
  calls: readonly string[]
): void => {
  if (log.putAway.has(questionId)) {
    return;
  }
  const at = Date.now() + GROW_AFTER_MS;
  change({
    putAway: new Set([...log.putAway, questionId]),
    learned: log.learned.map((lesson) =>
      calls.some((call) => lesson.id.startsWith(`${call}:`))
        ? { ...lesson, at }
        : lesson
    ),
  });
};

/** Forgets what the tab saw: it was the thinking of whoever signed out. */
export const forgetThinking = (): void => {
  taught.clear();
  change(empty);
};

/** What the tab saw of Grasp's thinking, renewed as it changes. */
export const useThinkingLog = (): ThinkingLog =>
  useSyncExternalStore(subscribe, () => log);
