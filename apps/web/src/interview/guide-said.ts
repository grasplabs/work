import { useEffect, useState, useSyncExternalStore } from "react";

// What Stephen says in the quick guide (guide.tsx), for the transcript:
// each step's words come in as he says them, at the pace of speech, and
// stay at the top of the transcript for as long as the page is open. They
// are kept on this page only, never with the conversation: the guide is
// how the screen works, not part of what they tell him.

/** How fast his words come in, in characters a second: the pace of the stage (loop.ts). */
const charsPerSecond = 15;

interface Step {
  text: string;
  /** When he began to say it, in ms (performance.now). */
  at: number;
}

/** What he said, by the step he said it at: a step said again, in another language, says it anew. */
let steps: Step[] = [];
const listeners = new Set<() => void>();

const told = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

/** He begins to say `text` at step `place`. */
export const guideSays = (place: number, text: string): void => {
  const next = [...steps];
  next[place] = { text, at: performance.now() };
  // Steps skipped (a control that isn't on screen) leave no gap.
  steps = next;
  told();
};

/** The guide starts over: nothing of it is said yet. */
export const guideForgotten = (): void => {
  steps = [];
  told();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = (): Step[] => steps;

/** As much of `text` as is said `ms` after he began, to the end of its last whole word. */
const saidBy = (text: string, ms: number): string => {
  const count = Math.floor((ms / 1000) * charsPerSecond);
  if (count >= text.length) {
    return text;
  }
  const cut = text.lastIndexOf(" ", count);
  return cut <= 0 ? "" : text.slice(0, cut);
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
      saidBy(step.text, at - step.at).length < step.text.length
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
    .map((step) => saidBy(step.text, at - step.at))
    .filter((text) => text !== "");
  return { lines, saying: coming };
};
