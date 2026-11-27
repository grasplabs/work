import { useEffect, useState, useSyncExternalStore } from "react";

import { reachedNow } from "./speech.ts";

// What Stephen says in the quick guide (guide.tsx), for the transcript:
// each step's words come in as he says them, word by word with his voice
// (the line's own timings, speech.ts), never ahead of it, and
// stay at the top of the transcript for as long as the page is open. They
// are kept on this page only, never with the conversation: the guide is
// how the screen works, not part of what they tell him.

interface Step {
  text: string;
  /** When he began to say it, in ms (performance.now). */
  at: number;
  /** What stood of it when he was stopped part way (a pause): it stays while he says it again. */
  kept: string;
  /** Said to its end: all of it stands. */
  done: boolean;
}

/** What he said, by the step he said it at: a step said again, in another language, says it anew. */
let steps: (Step | undefined)[] = [];
const listeners = new Set<() => void>();

const told = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

/** He begins to say `text` at step `place`. */
export const guideSays = (place: number, text: string): void => {
  const next = [...steps];
  const was = next[place];
  // The same words again, after a pause: what stood of them stays, and the rest comes as he says it.
  const kept = was?.text === text ? was.kept : "";
  next[place] = {
    text,
    at: performance.now(),
    kept,
    done: was?.done === true && was.text === text,
  };
  // Steps skipped (a control that isn't on screen) leave no gap.
  steps = next;
  told();
};

/**
 * The guide (re)starts with `words`, a step's words at its place: what he
 * said of other words goes (another language, or from the top), and what
 * he said of these stays (back from a pause).
 */
export const guideStarts = (words: string[]): void => {
  steps = steps.map((step, place) =>
    step?.text === words[place] ? step : undefined
  );
  told();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = (): (Step | undefined)[] => steps;

/** `text` up to `count` characters, to the end of the word that reaches. */
const toWordEnd = (text: string, count: number): string => {
  if (count <= 0) {
    return "";
  }
  const end = text.indexOf(" ", count);
  return end === -1 ? text : text.slice(0, end);
};

/** What stands of `step` at `now`: what was kept of it, or more as his voice says more. */
const shownOf = (step: Step, now: number): string => {
  if (step.done) {
    return step.text;
  }
  if (step.at === -Infinity) {
    return step.kept;
  }
  const said = toWordEnd(step.text, reachedNow(step.text, now));
  return said.length > step.kept.length ? said : step.kept;
};

/** He said the step at `place` to its end: all of it stands. */
export const guideDone = (place: number): void => {
  const step = steps[place];
  if (step === undefined || step.done) {
    return;
  }
  const next = [...steps];
  next[place] = { ...step, done: true };
  steps = next;
  told();
};

/**
 * He is stopped part way (paused): what he said so far stands, and no more
 * comes until he says it again.
 */
export const guideHeld = (): void => {
  const now = performance.now();
  steps = steps.map((step) =>
    step === undefined
      ? step
      : { ...step, at: -Infinity, kept: shownOf(step, now) }
  );
  told();
};

/** Calls `tick` every little while, until stopped. */
const ticking = (tick: () => void): (() => void) => {
  const every = window.setInterval(tick, 120);
  return () => {
    window.clearInterval(every);
  };
};

/** His guide lines as far as he has said them, oldest first, and whether one is still coming in. */
export const useGuideSaid = (): { lines: string[]; saying: boolean } => {
  const now = useSyncExternalStore(subscribe, snapshot);
  const [at, setAt] = useState(() => performance.now());
  const coming = now.some(
    (step) =>
      step !== undefined &&
      step.at !== -Infinity &&
      shownOf(step, at).length < step.text.length
  );
  useEffect(
    () =>
      coming
        ? ticking(() => {
            setAt(performance.now());
          })
        : undefined,
    [coming]
  );
  const lines = now
    .filter((step) => step !== undefined)
    .map((step) => shownOf(step, at))
    .filter((text) => text !== "");
  return { lines, saying: coming };
};
