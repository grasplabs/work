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
 * How long a turn took, in milliseconds, from its question to its last
 * reply; undefined for a turn with no reply, or one too short to say
 * (under a tenth of a second).
 */
export const workedMs = ({ asked, replies }: Turn): number | undefined => {
  const last = replies.at(-1);
  if (last === undefined) {
    return undefined;
  }
  const ms = Date.parse(last.at) - Date.parse(asked.at);
  return Number.isFinite(ms) && ms >= 100 ? ms : undefined;
};

/**
 * How long Grasp worked on each question it is done with, in
 * milliseconds, by the ID of the question's first reply: the line over
 * that reply says it. The question it still works on (`unfinished`) has
 * no time yet.
 */
export const workedFor = (
  turns: readonly Turn[],
  unfinished?: Turn
): Map<number, number> => {
  const worked = new Map<number, number>();
  for (const turn of turns) {
    const [first] = turn.replies;
    const ms = turn === unfinished ? undefined : workedMs(turn);
    if (first !== undefined && ms !== undefined) {
      worked.set(first.id, ms);
    }
  }
  return worked;
};

/**
 * A length of time in the parts it is said short in, as #2503 says it:
 * seconds to a tenth under ten seconds ("5.0s"), whole seconds under a
 * minute ("14s"), else minutes and the seconds over them ("2m 05s").
 */
export const shortTime = (
  ms: number
): { minutes: number; seconds: number; tenths: boolean } => {
  if (ms < 9950) {
    return { minutes: 0, seconds: Math.round(ms / 100) / 10, tenths: true };
  }
  const whole = Math.round(ms / 1000);
  return {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
    tenths: false,
  };
};
