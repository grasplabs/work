import { useReducedMotion } from "@grasp-os/ui/lib/utils";
import { useEffect, useState } from "react";

// His words in the transcript as he says them, let out the way the chat
// lets out an answer being written (Damsko's MessageResponse,
// `useSmoothText`): each frame takes a share of what is still to show, so a
// burst is spread over about CATCH_UP and never lands as a lump, and only
// whole words show, one after the other. Once he is through, or with
// reduced motion, the whole line stands at once.

/** The time it takes to catch up with what has come: a burst is spread over about this long, in ms. */
const CATCH_UP = 180;

/** Runs `step` once a frame with the share of CATCH_UP since the last one; returns what stops it. */
const everyFrame = (step: (share: number) => void): (() => void) => {
  let last = performance.now();
  let frame = 0;
  const tick = (now: number): void => {
    step(Math.min(1, (now - last) / CATCH_UP));
    last = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/** `text` up to `count` characters, to the end of its last whole word. */
const wholeWords = (text: string, count: number): string => {
  if (count >= text.length) {
    return text;
  }
  const cut = text.lastIndexOf(" ", count);
  return cut <= 0 ? "" : text.slice(0, cut);
};

/** `text` let out smoothly while `streaming`, word by word; all of it otherwise. */
export const useSmoothWords = (text: string, streaming: boolean): string => {
  const reduced = useReducedMotion();
  const paced = streaming && !reduced;
  // Words there when it is first drawn are not news: they show at once.
  const [shown, setShown] = useState(paced ? 0 : text.length);
  // Not paced, or the text was replaced by a shorter one: in step.
  if ((!paced && shown !== text.length) || shown > text.length) {
    setShown(text.length);
  }
  const behind = paced && shown < text.length;
  const end = text.length;
  useEffect(
    () =>
      behind
        ? everyFrame((share) => {
            setShown((at) =>
              Math.min(end, at + Math.max(1, Math.ceil((end - at) * share)))
            );
          })
        : undefined,
    [behind, end]
  );
  return paced ? wholeWords(text, Math.min(shown, text.length)) : text;
};
