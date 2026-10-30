// The beats of a step of Grasp's thinking (grasplabs/prototype
// `lib/thinking-beats.ts`): what the brain says it does, moment by moment,
// as data, and how long each line stays up so a person reads it. The page
// words a beat in the reader's language (`beatWords`, play.ts).

/** What the brain says it does at a beat, as data. */
export type BeatSay =
  | { kind: "reading"; name: string }
  | { kind: "pain"; team: string; words: string }
  | { kind: "same"; team: string }
  | { kind: "other"; team: string };

/**
 * A moment within a step: what the brain does then, said in the line over
 * the shape, what lights up, and the thread it runs, from one neuron to
 * another by id; when it begins, in milliseconds after its step began.
 */
export interface ThinkingBeat {
  at: number;
  lit: string[];
  thread?: [string, string];
  say: BeatSay;
}

/**
 * How long a line stays up, so a person reads it before the next one
 * comes: a moment to see that it changed and a little for every letter,
 * never less than `least` nor more than `most`. Thinking is work still
 * going on, so these are a reader's times, not a control's.
 */
export const READ = { glance: 900, letter: 48, least: 1800, most: 5200 };

/** How long a line of so many letters stays up. */
export const readFor = (letters: number): number =>
  Math.min(
    READ.most,
    Math.max(READ.least, READ.glance + READ.letter * letters)
  );

/** About how many letters a beat's line has, as English words it: enough to time it by. */
export const sayLength = (say: BeatSay): number => {
  switch (say.kind) {
    case "reading": {
      return 8 + say.name.length;
    }
    case "pain": {
      return say.team.length + say.words.length + 4;
    }
    case "same": {
      return say.team.length + 15;
    }
    case "other": {
      return say.team.length + 16;
    }
    default: {
      return 0;
    }
  }
};

/**
 * The beats' pace: the step's own sentence first, as long as it takes to
 * read (`lead`); a list longer than `named` is gone through a `pass` apart
 * under one line.
 */
export const BEAT = { lead: 1900, named: 4, pass: 560 };

const sameSay = (one: BeatSay, other: BeatSay): boolean =>
  JSON.stringify(one) === JSON.stringify(other);

/**
 * Beats one after the other from the step's start, once its own sentence
 * is read, each as long as its line takes to read; along a list under one
 * line, a pass apart.
 */
export const inTurn = (
  beats: readonly Omit<ThinkingBeat, "at">[],
  lead = BEAT.lead
): ThinkingBeat[] => {
  let at = lead;
  return beats.map((beat, index) => {
    const timed = { ...beat, at };
    const next = beats[index + 1];
    at +=
      next !== undefined && sameSay(next.say, beat.say)
        ? BEAT.pass
        : readFor(sayLength(beat.say));
    return timed;
  });
};

/** When a step's beats are over: its last line read. */
export const beatsEnd = (beats: readonly ThinkingBeat[]): number => {
  const last = beats.at(-1);
  return last === undefined ? 0 : last.at + readFor(sayLength(last.say));
};

const trailingPunctuation = /[,:;]$/u;

/** Words cut at a word to at most so many letters, with an ellipsis when cut. */
export const cut = (text: string, most: number): string =>
  text.length <= most
    ? text
    : `${text.slice(0, text.lastIndexOf(" ", most)).replace(trailingPunctuation, "")}…`;
