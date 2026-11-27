import { colors, duration, media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { readingSeconds } from "../onboarding/setup.ts";
import { voice } from "./interview.stylex.ts";

// Stephen's words lighting up as he says them (prototype
// `onboarding/spoken-text.tsx`): said words in ink, the word being said
// warm, the rest waiting in grey; when the line is over, every word eases
// back to the text around it. When the voice says a line (speech.ts), its
// words light up as they are said; a line he says without it here, at the
// pace of speech.

const looks = stylex.create({
  // Back to the text around it, slowly, once the line is over.
  rest: { transitionDuration: duration.arrive },
  said: { color: colors.foreground, transitionDuration: duration.ui },
  saying: { color: voice.heat, transitionDuration: duration.hover },
  waiting: { color: colors.subtleForeground, transitionDuration: duration.ui },
});

const styles = stylex.create({
  word: {
    transitionProperty: { default: "color", [media.reducedMotion]: "none" },
    transitionTimingFunction: duration.ease,
  },
});

const wordPattern = /\S+\s*/gu;

/** A text's words, each with the spaces after it, and where it starts and ends. */
export const wordsOf = (
  text: string
): { word: string; start: number; end: number }[] =>
  Array.from(text.matchAll(wordPattern), (match) => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].trimEnd().length,
  }));

/**
 * When each word of `line` from `from` on is said, in milliseconds from
 * the start, and how far the line is said then: one past the first letter
 * of the next word, which is the one being said.
 */
export const scheduleOf = (
  line: string,
  from: number
): { after: number; reached: number }[] => {
  const words = wordsOf(line).filter(({ end }) => end > from);
  let after = 0;
  return words.map(({ start, end }, at) => {
    after += readingSeconds(line.slice(Math.max(start, from), end + 1)) * 1000;
    const next = words[at + 1];
    return {
      after,
      reached: next === undefined ? line.length : next.start + 1,
    };
  });
};

/**
 * How many characters of `line` are said by now, while it is `speaking`:
 * from `from` on, a word at a time, at the pace of speech. -1 once it is
 * not being said, when its words rest.
 */
export const useSaid = ({
  line,
  saying,
  from,
  speaking,
}: {
  line: string;
  saying: number;
  from: number;
  speaking: boolean;
}): number => {
  // The word being said is warm: the count stands one past its first letter.
  const [said, setSaid] = useState({ saying, at: from + 1 });
  useEffect(() => {
    const timers = speaking
      ? scheduleOf(line, from).map(({ after, reached }) =>
          window.setTimeout(() => {
            setSaid({ saying, at: reached });
          }, after)
        )
      : [];
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [line, saying, from, speaking]);
  if (!speaking) {
    return -1;
  }
  return said.saying === saying ? Math.max(said.at, from + 1) : from + 1;
};

/** `text` as it stands in a line being said: it starts at `from` in that line, and `said` of it are said. */
export const SpokenText = ({
  text,
  from = 0,
  said,
}: {
  text: string;
  from?: number;
  said: number;
}) => (
  <>
    {wordsOf(text).map(({ word, start, end }) => {
      const first = from + start;
      const last = from + end;
      let look: keyof typeof looks = "waiting";
      if (said < 0) {
        look = "rest";
      } else if (said >= last) {
        look = "said";
      } else if (said > first) {
        look = "saying";
      }
      return (
        <span
          data-said={look}
          key={start}
          {...stylex.props(styles.word, looks[look])}
        >
          {word}
        </span>
      );
    })}
  </>
);

/** A first sentence shorter than this is a word of thanks before the question: they stand large together. */
const titleAtLeast = 32;

/**
 * A line as it is shown: its first sentence large and the rest under it,
 * from where the rest starts in the line; a short first sentence ("Got
 * it.") stays large with the one after it, which carries the question.
 * The cut is where a sentence ends, decided by what comes before it alone,
 * so it never moves while the line grows as he says it: a word once shown
 * stays where it stands, never taken from the title into the text under it.
 */
export const shownAs = (
  line: string
): { title: string; rest: string; restAt: number } => {
  for (const end of line.matchAll(/(?<=[.?!…])\s+(?=\S)/gu)) {
    if (end.index >= titleAtLeast) {
      const restAt = end.index + end[0].length;
      return {
        title: line.slice(0, end.index),
        rest: line.slice(restAt),
        restAt,
      };
    }
  }
  return { title: line, rest: "", restAt: line.length };
};

/**
 * The question a line of his ends in, as their screen shows it while he
 * talks around it out loud: its last sentence that asks, and where it
 * starts in the line; null when it asks nothing (yet). A sentence ends
 * where `shownAs` cuts one, so a Spanish "¿" and a French " ?" stay in it.
 */
export const questionOf = (
  line: string
): { question: string; at: number } | null => {
  let found: { question: string; at: number } | null = null;
  let start = 0;
  const ends = [
    ...Array.from(line.matchAll(/(?<=[.?!…])\s+(?=\S)/gu), (end) => ({
      at: end.index,
      next: end.index + end[0].length,
    })),
    { at: line.trimEnd().length, next: line.length },
  ];
  for (const { at, next } of ends) {
    const sentence = line.slice(start, at).trim();
    if (/[?？]$/u.test(sentence)) {
      found = {
        question: sentence,
        at: start + line.slice(start).search(/\S/u),
      };
    }
    start = next;
  }
  return found;
};
