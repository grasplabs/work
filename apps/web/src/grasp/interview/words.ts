// The words Interview shows and says, in English. The product gives them in its languages through
// GraspWords (src/words), as the catalogue's `interview`; a caller's `words` still win until the
// breaking release's step 5. Times are words too: "12:04" and "45 min" come from `clock` and `length`.
import { useWords, withGiven } from "../words/words";
import type { InterviewWords } from "./types";

/** "12:04", or "1:02:05" past an hour, from milliseconds. */
const clock = (ms: number) => {
  const whole = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
};

/** "45 min", never under one. */
const length = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

export const englishWords: InterviewWords = {
  clock,
  length,
  passage: String,
  atPassage: (n) => `passage ${n}`,
  seek: (time, who) => `Go to ${time}, ${who}`,
  turn: (who, at) => `${who}, ${at}`,
  transcript: "Transcript",
  timeline: "Conversation timeline",
  speakers: "Speakers",
  chapters: "Chapters",
  highlight: "Highlight",
  kinds: "Kinds of highlight",
  kindCount: (kind, count) => `${kind} ${count}`,
  runs: "Who spoke when",
  run: (who, from, to) => `${who}, ${from} to ${to}`,
  at: (what, time) => `${what} · ${time}`,
  mark: (kind, time) => `${kind} at ${time}`,
  count: (count, total) =>
    `${count} of ${total} ${total === 1 ? "interview" : "interviews"}`,
  cite: (interview, time) =>
    interview === "" ? time : `${interview}, ${time}`,
  control: (name, player) => `${name}, ${player}`,
  player: (who, time) => `${who} at ${time}`,
  sound: "Interview sound",
  origin: (how, said) =>
    ["Interview", how, said]
      .filter((part) => part !== undefined && part !== "")
      .join(" · "),
  search: "Search the transcript",
  previousMatch: "Previous match",
  nextMatch: "Next match",
  matchOf: (n, count) => `${n} of ${count}`,
  noMatches: "No matches",
};

/** The English words with the product's own over them. */
export const wordsOf = (
  given: Partial<InterviewWords> | undefined
): InterviewWords => ({ ...englishWords, ...given });

/** Its words: the product's, by its catalogue, else English; the caller's `words` still win. */
export const useInterviewWords = (
  given: Partial<InterviewWords> | undefined
): InterviewWords =>
  withGiven(useWords("interview", englishWords), given ?? {});

declare module "../words/words" {
  interface GraspWordsCatalog {
    interview: InterviewWords;
  }
}
