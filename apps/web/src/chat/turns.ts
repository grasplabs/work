import type { ChatMessage } from "@grasp-os/shared/chat";

// How long Grasp worked on each question, from what the thread already
// knows: when the question was asked, and when its last answer came. A
// question and what answers it are a turn: the agent may answer in several
// replies, with code steps and their results between them, until the next
// question.

type Asked = Extract<ChatMessage, { role: "user" }>;
type Answer = Extract<ChatMessage, { role: "assistant" }>;

/** A question and the replies to it, oldest first. */
export interface Turn {
  asked: Asked;
  replies: Answer[];
}

/** The chat's turns, oldest first; anything before its first question is none. */
export const turnsOf = (messages: readonly ChatMessage[]): Turn[] => {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ asked: message, replies: [] });
    } else if (message.role === "assistant") {
      turns.at(-1)?.replies.push(message);
    }
  }
  return turns;
};

/**
 * How many whole seconds a turn took, from its question to its last reply;
 * undefined for a turn with no reply, or one that took under a second.
 */
export const workedSeconds = ({ asked, replies }: Turn): number | undefined => {
  const last = replies.at(-1);
  if (last === undefined) {
    return undefined;
  }
  const seconds = Math.round(
    (Date.parse(last.at) - Date.parse(asked.at)) / 1000
  );
  return Number.isFinite(seconds) && seconds >= 1 ? seconds : undefined;
};

/**
 * How long Grasp worked on each question it is done with, by the ID of
 * the question's first reply: the line over that reply says it. The
 * question it still works on (`unfinished`) has no time yet.
 */
export const workedFor = (
  turns: readonly Turn[],
  unfinished?: Turn
): Map<number, number> => {
  const worked = new Map<number, number>();
  for (const turn of turns) {
    const [first] = turn.replies;
    const seconds = turn === unfinished ? undefined : workedSeconds(turn);
    if (first !== undefined && seconds !== undefined) {
      worked.set(first.id, seconds);
    }
  }
  return worked;
};

/** A length of time in minutes and the seconds over them, to be said short: "4m 21s". */
export const minutesAndSeconds = (
  seconds: number
): { minutes: number; rest: number } => ({
  minutes: Math.floor(seconds / 60),
  rest: seconds % 60,
});
