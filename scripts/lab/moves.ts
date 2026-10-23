/**
 * What a practice person does in an answer beside answering (people.ts),
 * and the rule Stephen's next line is held to after each: the score card's
 * hard turns (judge.ts). Each is a kind of moment of the next-question
 * bench (moments.ts), with its rule, so the two are judged alike.
 */
import { signalRules } from "./moments.ts";

export const moves = [
  "not an answer",
  "not an answer again",
  "few words",
  "a guess",
  "the official way",
  "two versions",
  "second hand",
  "why do you ask",
  "flood",
  "where to start",
  "do not know",
  "wrap up",
  "detour",
] as const;
export type Move = (typeof moves)[number];

/** Answers that are no answer at all. */
export const nonsense: readonly Move[] = [
  "not an answer",
  "not an answer again",
];

/** The rule for Stephen's next line after each move: the rule of that kind of moment. */
export const moveRules: Readonly<Record<Move, string>> = signalRules;
