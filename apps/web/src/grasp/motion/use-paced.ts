// usePaced: text that is still arriving, let out at a steady pace (pace.ts), once per frame.
//
//   const paced = usePaced(answerSoFar, streaming);
//   paced.text      what is out
//   paced.fresh     the pieces of it still arriving, as offsets, newest last (the fade itself is
//                   drawn by the box they are written into: use-arriving.ts)
//   paced.settled   before this offset the text is simply text
//   paced.done      no more is coming and all of it is out and has arrived
//
// Text that is there when the part is first drawn is simply there: only what arrives while `live`
// is paced. (A row of a long thread is drawn again when it scrolls back into view, and must not
// write itself out again.) The one exception is an answer's opening words, which arrive as the
// rest will. With reduced motion it comes by whole sentences at the same pace, and nothing counts as
// fresh, so nothing fades.
"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { ARRIVE_LENGTH } from "./arrive-highlight";
import { HALF_WORD_WAIT, paces, startPace, stepPace } from "./pace";
import type { PaceName, PaceState, PaceUnit, Released } from "./pace";

/**
 * How a part that holds paced words hears that they are still arriving: it gives a setter here,
 * and every usePaced under it says so. A Chat message holds its actions until its Markdown's last
 * word is out.
 */
export const ArrivingContext = createContext<
  ((arriving: boolean) => void) | null
>(null);

/** How long a piece takes to arrive, in ms: its fade (arrive-highlight.ts), within the 300ms a step may take. */
export const PACE_SETTLE = ARRIVE_LENGTH;

export interface PacedOptions {
  /**
   * How fast the words come: `calm`, `steady` or `quick`. Each keeps up with a fast stream; they
   * differ in the slowest pace and in how far behind the words may fall.
   * @default "quick"
   */
  pace?: PaceName;
}

/** What usePaced gives back, each frame. */
export interface Paced {
  /** The words shown so far: the start of the whole text, growing a word or a sentence at a time. */
  text: string;
  /** The pieces released lately and still fading in, each with where it starts and when it came. */
  fresh: Released[];
  /** How much of `text` has finished fading in, as an offset: draw what is past it as arriving. */
  settled: number;
  /** True once the stream has ended and every word is shown and settled. */
  done: boolean;
}

interface Latest {
  text: string;
  live: boolean;
  pace: PaceName;
  unit: PaceUnit;
  settle: number;
}

interface Loop {
  state: PaceState;
  latest: Latest;
  /** The frame asked for, or 0 while it rests. */
  frame: number;
  at: number;
  /** When more text last came, for a word still being typed that waits through a stall. */
  grew: number;
}

/** Whether a word still being typed waits for its end, so the loop must wake to let it out after a stall. */
const halfWordWaits = (held: Loop, now: number) =>
  held.latest.live &&
  held.latest.unit === "word" &&
  held.state.shown < held.latest.text.length &&
  now - held.grew <= HALF_WORD_WAIT + 50;

/** One frame: the pace moved on, and another frame asked for while anything changed. */
const tick = (
  loop: RefObject<Loop>,
  show: (state: PaceState) => void,
  now: number
) => {
  const held = loop.current;
  const { text, live, pace, unit, settle } = held.latest;
  const next = stepPace(held.state, {
    text,
    live,
    now,
    elapsed: now - held.at,
    rate: paces[pace],
    unit,
    settle,
    quiet: now - held.grew,
  });
  held.at = now;
  // It rests once nothing moved and nothing is still arriving (nor a half word about to be let out).
  if (
    next === held.state &&
    next.fresh.length === 0 &&
    !halfWordWaits(held, now)
  ) {
    held.frame = 0;
    return;
  }
  // The page is told only when what it draws changed: more out, or a piece done arriving.
  const drawn =
    next.shown !== held.state.shown ||
    next.fresh.length !== held.state.fresh.length;
  held.state = next;
  if (drawn) {
    show(next);
  }
  held.frame = requestAnimationFrame((time) => {
    tick(loop, show, time);
  });
};

const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An answer no longer than this when first drawn is its opening words. */
const OPENING = 120;

const startFor = (text: string, live: boolean) =>
  startPace(live && text.length <= OPENING ? 0 : text.length);

export const usePaced = (
  text: string,
  live: boolean,
  { pace = "quick" }: PacedOptions = {}
): Paced => {
  const [shown, setShown] = useState<PaceState>(() => startFor(text, live));
  const loop = useRef<Loop>({
    state: shown,
    latest: { text, live, pace, unit: "word", settle: PACE_SETTLE },
    frame: 0,
    at: 0,
    grew: 0,
  });

  useEffect(() => {
    const held = loop.current;
    const before = held.latest;
    const still = reduced();
    // Word by word; with reduced motion, whole sentences with no fade.
    held.latest = {
      text,
      live,
      pace,
      unit: still ? "sentence" : "word",
      settle: still ? 0 : PACE_SETTLE,
    };
    if (text !== before.text) {
      held.grew = performance.now();
    }
    // Other text than what is out (a new answer in the same place), or text changed after it was
    // done: nothing to pace from, so it starts again, or is simply there.
    const goesOn = text.startsWith(before.text.slice(0, held.state.shown));
    const edited = !live && !before.live && text !== before.text;
    if (!goesOn || edited) {
      held.state = startFor(text, live);
      setShown(held.state);
    }
    if (held.frame === 0) {
      held.at = performance.now();
      held.frame = requestAnimationFrame((time) => {
        tick(loop, setShown, time);
      });
    }
  }, [text, live, pace]);

  useEffect(() => {
    const held = loop.current;
    return () => {
      cancelAnimationFrame(held.frame);
      held.frame = 0;
    };
  }, []);

  const out = Math.min(shown.shown, text.length);
  const fresh = shown.fresh.filter((piece) => piece.end <= out);
  const done = !live && out >= text.length && fresh.length === 0;

  // Whatever holds this is told while words are still coming or arriving, and when they no longer are.
  const tell = useContext(ArrivingContext);
  useEffect(() => {
    tell?.(!done);
    return () => {
      tell?.(false);
    };
  }, [tell, done]);

  return {
    text: text.slice(0, out),
    fresh,
    settled: fresh[0]?.start ?? out,
    done,
  };
};
