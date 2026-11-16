// Pace: how an agent's words are let out, in Grasp UI. Text comes off the network in lumps (three
// words, a pause, forty words); it is never drawn as it comes. It waits here and is released at a
// steady pace that follows how much is waiting: as fast as reading while little waits, faster,
// smoothly, as more does, so it never falls far behind. When the stream ends, what is left drains
// in well under a second.
//
// Released by word (by `Intl.Segmenter`, so a script without spaces is cut where its words end), or,
// with reduced motion, by sentence: no fade, whole sentences at the same pace.
//
// A lump is let out at an even pace, not a pace that slows as it empties: the pace a lump asks for
// when it comes is kept until all that waits is out, so its last word is out within `within` of
// its arrival, not ever later. A word still being typed waits for its end, but not through a stall:
// once nothing new has come for HALF_WORD_WAIT, what has come of it is let out.
//
// This file is the arithmetic only, with no clock and no React, so it can be checked by itself.
// use-paced.ts runs it once per frame.

/** How fast: the slowest pace in words a second, and how far behind the words may fall, in ms. */
export interface PaceRate {
  /** Words a second while little waits. */
  floor: number;
  /** The words waiting are let out within about this long, so more waiting means a faster pace. */
  within: number;
  /** Once the stream has ended, what is left is out within this long. */
  drain: number;
}

/**
 * The paces to choose from. `quick` is the default: the quickest that is still smooth, so nobody
 * waits on the animation: a lump is out within 200ms of its arrival (at 60 frames a second, a
 * lump of 50 words is four or five words a frame), and the last words within 200ms of the end.
 */
export const paces = {
  calm: { floor: 14, within: 900, drain: 500 },
  steady: { floor: 22, within: 600, drain: 400 },
  quick: { floor: 40, within: 200, drain: 200 },
} as const satisfies Record<string, PaceRate>;

/**
 * How long a word still being typed waits for its end once nothing more comes, in ms: through a
 * stall it is let out as it is, and the rest of it follows when it comes.
 */
export const HALF_WORD_WAIT = 150;

export type PaceName = keyof typeof paces;

/** What is released at a time. */
export type PaceUnit = "word" | "sentence";

const words =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : undefined;
const sentences =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "sentence" })
    : undefined;

/** Where each word of `text` ends, with the spaces and marks after it, as offsets into it. */
const wordEnds = (text: string): number[] => {
  const ends: number[] = [];
  if (words === undefined) {
    for (const match of text.matchAll(/\S+\s*/gu)) {
      ends.push(match.index + match[0].length);
    }
    return ends;
  }
  let open = false;
  for (const part of words.segment(text)) {
    // A word starts a new piece; what is not a word (a space, a comma) stays with the word before.
    if (part.isWordLike === true && open) {
      ends.push(part.index);
    }
    open ||= part.isWordLike === true;
  }
  if (open) {
    ends.push(text.length);
  }
  return ends;
};

const sentenceEnds = (text: string): number[] => {
  if (sentences === undefined) {
    return [...text.matchAll(/[^.!?\n]*[.!?\n]+\s*/gu)].map(
      (match) => match.index + match[0].length
    );
  }
  const ends: number[] = [];
  for (const part of sentences.segment(text)) {
    ends.push(part.index + part.segment.length);
  }
  return ends;
};

const cutters = { word: wordEnds, sentence: sentenceEnds } as const;

/** One release: the text from `start` to `end` came out at `at`. */
export interface Released {
  start: number;
  end: number;
  at: number;
}

/** What a pacer holds between frames. Made by `startPace`, moved on by `stepPace`. */
export interface PaceState {
  /** How much of the text is out, as an offset into it. */
  shown: number;
  /** Words earned and not yet spent: the pace is in words a second, a frame is a fraction of one. */
  credit: number;
  /** How many words were waiting when the stream ended, for the drain. */
  left: number | null;
  /** The last releases, newest last: what is still arriving on the page. */
  fresh: Released[];
  /** The pace the words waiting asked for, in words a second, kept until none waits. */
  rate: number;
}

export const startPace = (shown = 0): PaceState => ({
  shown,
  credit: 0,
  left: null,
  fresh: [],
  rate: 0,
});

/**
 * A frame is never taken to be longer than this, so a tab that was hidden does not dump on return.
 * Long enough that a browser giving two frames a second (a window behind another) still keeps up.
 */
const LONGEST_FRAME = 500;

interface Step {
  /** Everything that has arrived. */
  text: string;
  /** Whether more may still come. */
  live: boolean;
  /** Now, and how long since the last step, in ms. */
  now: number;
  elapsed: number;
  rate: PaceRate;
  unit: PaceUnit;
  /** How long a release counts as still arriving, in ms: the length of its fade. */
  settle: number;
  /** How long since more text last came, in ms. */
  quiet?: number;
}

/**
 * The state one frame on: more of the text out, at the pace the waiting words ask for, and the
 * releases that have finished arriving forgotten. Returns the same state when nothing changed.
 */
/** Whether the last piece is still being written and waits: half a word (until a stall), half a sentence. */
const isOpen = (
  pieces: number[],
  waiting: string,
  unit: PaceUnit,
  quiet: number
) => {
  if (pieces.at(-1) !== waiting.length) {
    return false;
  }
  // A word with its space after it is whole; one that has had nothing after it for a while is let out.
  return unit !== "word" || (!/\s$/u.test(waiting) && quiet < HALF_WORD_WAIT);
};

/**
 * How much of what waits the credit pays for: by word, each piece costs one; by sentence, a
 * piece costs the words it holds, so the pace is the same and the text simply comes in larger pieces.
 */
const spend = (
  ends: number[],
  waiting: string,
  unit: PaceUnit,
  credit: number
) => {
  let spent = 0;
  let taken = 0;
  let from = 0;
  for (const end of ends) {
    const cost =
      unit === "word"
        ? 1
        : Math.max(1, wordEnds(waiting.slice(from, end)).length);
    if (spent + cost > credit) {
      break;
    }
    spent += cost;
    taken = end;
    from = end;
  }
  return { spent, taken };
};

export const stepPace = (
  state: PaceState,
  { text, live, now, elapsed, rate, unit, settle, quiet = 0 }: Step
): PaceState => {
  const fresh = state.fresh.filter((release) => now - release.at < settle);
  const waiting = text.slice(state.shown);
  const pieces = cutters[unit](waiting);
  // While more may come, a piece at the very end may still be being written (half a word, half a
  // sentence): it waits.
  const held =
    live && isOpen(pieces, waiting, unit, quiet) ? pieces.slice(0, -1) : pieces;
  // Once no more comes, what no piece took (a last sentence with no end) goes out too.
  const ends =
    live || waiting.length === 0 || held.at(-1) === waiting.length
      ? held
      : [...held, waiting.length];
  if (ends.length === 0) {
    // Nothing to release: what was earned is not saved up for the next lump.
    return fresh.length === state.fresh.length &&
      state.credit === 0 &&
      state.rate === 0
      ? state
      : { ...state, credit: 0, fresh, rate: 0 };
  }
  const counted = unit === "word" ? ends.length : wordEnds(waiting).length;
  const left = live ? null : (state.left ?? counted);
  // The pace a lump asks for is kept while it is let out, so it empties evenly and its last word is
  // out within `within`; a new lump can only make it quicker.
  const ask = Math.max(state.rate, (counted / rate.within) * 1000);
  const drain = left === null ? 0 : (left / rate.drain) * 1000;
  const pace = Math.max(rate.floor, ask, drain);
  const credit =
    state.credit + (pace * Math.min(elapsed, LONGEST_FRAME)) / 1000;
  const { spent, taken } = spend(ends, waiting, unit, credit);
  if (taken === 0) {
    return { ...state, credit, left, fresh, rate: ask };
  }
  const shown = state.shown + taken;
  // With no fade (reduced motion) a release has arrived the moment it is out.
  const arriving =
    settle > 0
      ? [...fresh, { start: state.shown, end: shown, at: now }]
      : fresh;
  // Once all that waited is out, the next lump sets its own pace.
  return {
    shown,
    credit: credit - spent,
    left,
    fresh: arriving,
    rate: taken === ends.at(-1) ? 0 : ask,
  };
};
