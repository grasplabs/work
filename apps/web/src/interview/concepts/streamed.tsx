import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { duration, media } from "@grasp-os/ui/lib/tokens.stylex";
import { announce } from "@grasp-os/ui/lib/utils";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// CONCEPT ONLY: Stephen's typed line as it streams in, by the streaming spec
// (grasplabs/damsko#54) until Damsko ships it in MessageResponse:
// - whole words, cut by `Intl.Segmenter` (a word keeps the spaces and marks
//   after it), never letters;
// - each word fades in on opacity alone, `duration.ui` (250ms) on
//   `duration.easeInOut`: no movement, blur or scale;
// - the first word of a chunk shows at once, the rest of it spread evenly
//   over the time until the next chunk is likely, never more than 400ms
//   behind what has arrived, never slower than 45 characters a second, and
//   at most four words in one frame;
// - the moving words are hidden from assistive tech (no live region on
//   them); the whole line is said once, when it is all there;
// - under reduced motion, words show as they arrive, without the fade.
//
// The concept has no model: `useFeed` lets the fixture's line in as a model
// would, a few words at a time at an uneven pace.

const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  word: {
    animationName: { default: fadeIn, [media.reducedMotion]: "none" },
    animationDuration: duration.ui,
    animationTimingFunction: duration.easeInOut,
  },
});

/** The most a chunk's words lag behind its arrival. */
const mostBehindMs = 400;
/** The slowest pace words are let out at, in characters a second. */
const slowestCharsPerSecond = 45;
/** The most words shown in one frame. */
const mostWordsPerFrame = 4;

const reduce = "(prefers-reduced-motion: reduce)";

/** No cleanup to do. */
const nothing = (): void => {
  // Nothing was started.
};

const watchMotion = (changed: () => void) => {
  const query = window.matchMedia(reduce);
  query.addEventListener("change", changed);
  return () => {
    query.removeEventListener("change", changed);
  };
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** A text's words, each with the spaces and marks after it; what leads the first word stays with it. */
export const wordsIn = (text: string): string[] => {
  const words: string[] = [];
  let lead = "";
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    const last = words.length - 1;
    if (isWordLike === true) {
      words.push(lead + segment);
      lead = "";
    } else if (last < 0) {
      lead += segment;
    } else {
      words[last] += segment;
    }
  }
  return lead === "" ? words : [...words, lead];
};

/** Lets `count` words of a line in as a model would; returns what stops it. */
const feed = (count: number, send: (words: number) => void): (() => void) => {
  const timers: number[] = [];
  let at = 0;
  let after = 0;
  for (let chunk = 0; at < count; chunk += 1) {
    // Two to six words a chunk, 90 to 330ms apart: a model's uneven rhythm, the same each time.
    at = Math.min(count, at + 2 + ((chunk * 7) % 5));
    after += 90 + ((chunk * 113) % 241);
    const upTo = at;
    timers.push(
      window.setTimeout(() => {
        send(upTo);
      }, after)
    );
  }
  return () => {
    for (const timer of timers) {
      window.clearTimeout(timer);
    }
  };
};

/** The fixture's line as a model sends it: while `streaming`, a few words at a time; else all of it. */
export const useFeed = (text: string, streaming: boolean): string => {
  const [sent, setSent] = useState({ text, words: 0 });
  const words = wordsIn(text);
  const count = words.length;
  useEffect(
    () =>
      streaming
        ? feed(count, (upTo) => {
            setSent({ text, words: upTo });
          })
        : nothing,
    [text, streaming, count]
  );
  if (!streaming) {
    return text;
  }
  return sent.text === text ? words.slice(0, sent.words).join("") : "";
};

/** When each word of a line is due, and when its last chunk came. */
interface Plan {
  due: number[];
  lastChunk: number;
}

/** Plans the words of `text` that are new since `plan`, from now: the chunk's first at once, the rest spread evenly. */
const planChunk = (plan: Plan, text: string, now: number): void => {
  const fresh = wordsIn(text).slice(plan.due.length);
  if (fresh.length === 0) {
    return;
  }
  // Over the time since the last chunk (the likely gap to the next), never more than 400ms.
  const spread =
    plan.lastChunk === 0
      ? mostBehindMs
      : Math.min(mostBehindMs, now - plan.lastChunk);
  const evenGap = fresh.length > 1 ? spread / (fresh.length - 1) : 0;
  let at = now;
  for (const [index, word] of fresh.entries()) {
    if (index > 0) {
      // Never slower than 45 characters a second.
      at += Math.min(evenGap, (word.length / slowestCharsPerSecond) * 1000);
    }
    plan.due.push(at);
  }
  plan.lastChunk = now;
};

/** Lets the planned words out a frame at a time, at most four a frame; returns what stops it. */
const letOut = (
  plan: Plan,
  show: (next: (was: number) => number) => void
): (() => void) => {
  let frame = 0;
  const tick = (now: number) => {
    const dueNow = plan.due.filter((due) => due <= now).length;
    show((was) => Math.max(was, Math.min(dueNow, was + mostWordsPerFrame)));
    if (dueNow < plan.due.length) {
      frame = requestAnimationFrame(tick);
    }
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/**
 * How many words of `text` (what has arrived) are shown: those there when
 * it is first drawn at once, each later chunk by the plan above; all of
 * them at once under reduced motion.
 */
const useShown = (text: string, reduced: boolean): number => {
  const count = wordsIn(text).length;
  // What was there when it was first drawn is not news: it shows at once.
  const first = useRef(count);
  const [shown, setShown] = useState(count);
  const plan = useRef<Plan>({ due: [], lastChunk: 0 });
  useEffect(() => {
    if (plan.current.due.length === 0 && plan.current.lastChunk === 0) {
      plan.current.due = Array.from({ length: first.current }, () => 0);
    }
    planChunk(plan.current, text, performance.now());
    return reduced ? nothing : letOut(plan.current, setShown);
  }, [text, reduced]);
  return reduced ? count : Math.min(shown, count);
};

/** Each word with where it starts in the line: its key, which never changes once it is shown. */
const placed = (words: string[]): { word: string; from: number }[] => {
  let from = 0;
  return words.map((word) => {
    const at = from;
    from += word.length;
    return { word, from: at };
  });
};

/**
 * A line of Stephen's as it streams in, word by word; `done` once all of it
 * has arrived, when it is said once to a screen reader.
 */
export const StreamedLine = ({
  text,
  streaming,
}: {
  /** What has arrived so far. */
  text: string;
  /** More may come. */
  streaming: boolean;
}) => {
  const reduced = useSyncExternalStore(
    watchMotion,
    () => window.matchMedia(reduce).matches,
    () => false
  );
  const words = wordsIn(text);
  const shown = useShown(text, reduced);
  const whole = !streaming && shown >= words.length;
  useEffect(() => {
    if (whole && text !== "") {
      announce(text);
    }
  }, [whole, text]);
  return (
    <>
      <span aria-hidden="true">
        {placed(words.slice(0, shown)).map(({ word, from }) => (
          <span key={from} {...stylex.props(styles.word)}>
            {word}
          </span>
        ))}
      </span>
      {whole ? <span {...stylex.props(visuallyHidden)}>{text}</span> : null}
    </>
  );
};
