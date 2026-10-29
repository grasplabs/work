import type { ChatMessage } from "@grasp-os/shared/chat";
import type { ThinkingStep } from "@grasp-os/shared/thinking";

// Grasp's thinking as it comes, over time (grasplabs/prototype
// `lib/thinking-play.ts`): the steps a question's answer showed, the
// answer the brain plays now, and when each of its steps is shown. A step
// is kept with the answer as the result of the call that showed it
// (`ChatMessage.thinking`), so an answer read again plays again.

/** The steps of Grasp's thinking for one question, in the order they came, each with its call. */
export interface ThinkingOf {
  /** The question they answer: what keys the thinking, and plays it again. */
  questionId: number;
  steps: ThinkingStep[];
  calls: string[];
}

/** The thinking for each question of a chat that showed some, oldest first. */
export const thinkingIn = (messages: readonly ChatMessage[]): ThinkingOf[] => {
  const found: ThinkingOf[] = [];
  let current: ThinkingOf | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      current = { questionId: message.id, steps: [], calls: [] };
    } else if (message.role === "result" && message.thinking !== undefined) {
      if (current !== undefined && current.steps.length === 0) {
        found.push(current);
      }
      current?.steps.push(message.thinking);
      current?.calls.push(message.callId);
    }
  }
  return found;
};

/** The thinking the brain plays now, as Grasp answers. */
export interface LiveThinking extends ThinkingOf {
  /** When each step reached this tab, by its call; none for one that came before. */
  arrivals: (number | undefined)[];
  /** Grasp is still answering. */
  open: boolean;
}

/**
 * The thinking the brain plays now: the newest question's steps, once its
 * first reached this tab as Grasp answered; while the answer is written
 * (`running`), and after it until the person puts it away. None for a
 * question without steps.
 */
export const liveThinking = (
  messages: readonly ChatMessage[],
  arrived: ReadonlyMap<string, number>,
  putAway: ReadonlySet<number>,
  running: boolean
): LiveThinking | undefined => {
  const last = messages.findLast((message) => message.role === "user");
  const thinking = thinkingIn(messages).at(-1);
  if (
    last === undefined ||
    thinking === undefined ||
    thinking.questionId !== last.id ||
    putAway.has(thinking.questionId)
  ) {
    return undefined;
  }
  const arrivals = thinking.calls.map((call) => arrived.get(call));
  return arrivals[0] === undefined
    ? undefined
    : { ...thinking, arrivals, open: running };
};

/**
 * When each step is shown, in ms since 1970: the first at `start`, each
 * next one when it arrived, but never before the one before it had its own
 * time (`paces`), so a step that comes quickly is still seen. A replay has
 * no arrivals: each step follows the one before at its pace.
 */
export const thinkingSchedule = (
  start: number,
  paces: readonly number[],
  arrivals: readonly (number | undefined)[] = []
): number[] => {
  const began: number[] = [];
  for (const at of paces.keys()) {
    const earliest =
      at === 0 ? start : (began[at - 1] ?? start) + (paces[at - 1] ?? 0);
    began.push(Math.max(earliest, arrivals[at] ?? 0));
  }
  return began;
};
