import { interviewPhases } from "@grasp-os/shared/interview-links";
import type { FactTag, InterviewPhase } from "@grasp-os/shared/interview-turn";
import type { InterviewKind } from "@grasp-os/shared/onboarding";

// What an interview still misses, from what was written down so far: the
// list Stephen is given every turn (interview.ts `briefOf`), so he asks for
// what the record lacks instead of walking a fixed script. Worked out from
// the kinds of the facts alone, never from their words: a list a model made
// would cost a call each turn, and could not be tested.

/** How many open things one turn names: enough to choose from, few enough to read. */
export const stillOpenMost = 5;

/** What is counted: how many facts of each kind were written down. */
type Counted = (tag: FactTag) => number;

interface Open {
  /** What is missing, as Stephen is told it. */
  ask: string;
  missing: (count: Counted) => boolean;
  /**
   * The part it is asked in, and the last it is open in. Once the
   * interview has passed it, it was asked or let go: someone who answered
   * "no" or "I don't know" left no fact, and is not asked again.
   */
  until: InterviewPhase;
  /**
   * What no kind of fact can show was answered: open only until he has
   * been in its part, where he asks it once.
   */
  once?: true;
}

const none = (count: Counted, ...tags: FactTag[]): boolean =>
  tags.every((tag) => count(tag) === 0);

/** The story of one piece has at least this many steps. */
const storySteps = 3;
/** The two numbers he never leaves without: how many, and how long. */
const neededNumbers = 2;

/** An employee's interview, in the order of its parts (`partsOf`). */
const own: readonly Open[] = [
  {
    ask: "which work comes back every day or week, and how often",
    missing: (count) => none(count, "task"),
    until: "week",
  },
  {
    ask: "which of it they would hand off first",
    missing: (count) => count("task") > 0 && none(count, "wish"),
    until: "week",
  },
  {
    ask: "the story of the last one, step by step",
    missing: (count) => count("step") < storySteps,
    until: "steps",
  },
  {
    ask: "where they do it: which system or screen",
    missing: (count) => none(count, "system"),
    until: "steps",
  },
  {
    ask: "who gets it after them, and how",
    missing: (count) => none(count, "next", "handoff"),
    until: "steps",
  },
  {
    ask: "where it waits, and for what",
    missing: (count) => none(count, "wait"),
    until: "steps",
  },
  {
    ask: "when it does not go like that, how many out of ten",
    missing: (count) => none(count, "exception"),
    until: "exceptions",
  },
  {
    ask: "how they decide, and what tells them it is okay",
    missing: (count) => none(count, "judgment", "rule"),
    until: "exceptions",
  },
  {
    ask: "how many in a normal week, and how long one takes",
    missing: (count) => count("number") < neededNumbers,
    until: "numbers",
  },
  {
    ask: "how they know it is done right",
    missing: (count) => none(count, "done"),
    until: "result",
  },
  {
    ask: "when they would stop and ask someone",
    missing: (count) => none(count, "stop"),
    until: "result",
  },
  {
    ask: "one real example to share",
    missing: (count) => none(count, "case"),
    until: "result",
  },
  // Open until a line of his was in the part that asks it, or a fact says
  // what they use.
  {
    ask: "whether they use AI for any of this (one short question)",
    missing: (count) => none(count, "ai"),
    until: "you",
    once: true,
  },
];

/** A lead's interview, in the order of its parts (`leadPartsOf`). */
const lead: readonly Open[] = [
  {
    ask: "which work the team does that comes back, one piece at a time",
    missing: (count) => none(count, "work"),
    until: "story",
  },
  // Who does a piece is written into its `work` fact, so no kind shows it
  // is missing.
  {
    ask: "who in the team does each piece, by name",
    missing: (count) => count("work") > 0,
    until: "steps",
    once: true,
  },
  {
    ask: "which piece takes the most time, and which goes wrong most often",
    missing: (count) => none(count, "exception", "wait", "handoff"),
    until: "exceptions",
    once: true,
  },
  {
    ask: "for each piece: about how many in a normal week, and how long one takes",
    missing: (count) => none(count, "number"),
    until: "numbers",
  },
  {
    ask: "whom to talk to first about each piece of work",
    missing: () => true,
    until: "result",
    once: true,
  },
  {
    ask: "whether the team uses AI in the work (one short question)",
    missing: (count) => none(count, "ai"),
    until: "you",
    once: true,
  },
];

const lists: Record<InterviewKind, readonly Open[]> = { own, lead };

/**
 * What an interview of `kind` still misses, the first to ask first, at
 * most five (`stillOpenMost`): from the kinds of the `facts` written down
 * so far, and the part the interview was in: a thing is open up to its own
 * part, and closed once the interview has passed it. Empty when nothing is
 * left to ask.
 */
export const stillOpen = (
  kind: InterviewKind,
  facts: readonly { tag: FactTag }[],
  phase: InterviewPhase
): string[] => {
  const count: Counted = (tag) =>
    facts.filter((fact) => fact.tag === tag).length;
  const at = interviewPhases.indexOf(phase);
  return lists[kind]
    .filter(({ missing, until, once }) => {
      const part = interviewPhases.indexOf(until);
      return missing(count) && (once === true ? at < part : at <= part);
    })
    .map(({ ask }) => ask)
    .slice(0, stillOpenMost);
};
