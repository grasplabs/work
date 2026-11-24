import { useEffect, useState } from "react";

import { readingSeconds } from "../onboarding/setup.ts";

// Stephen's words lighting up as he says them (prototype
// `onboarding/spoken-text.tsx`): said words in ink, the word being said
// warm, the rest waiting in grey; when the line is over, every word eases
// back to the text around it. When the voice says a line (speech.ts), its
// words light up as they are said; a line he says without it here, at the
// pace of speech.

const looks = {
  rest: "transition-colors duration-700",
  said: "text-foreground transition-colors duration-300",
  saying: "text-brain-heat transition-colors duration-150",
  waiting: "text-muted-foreground/60 transition-colors duration-300",
} as const;

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
        <span className={looks[look]} data-said={look} key={start}>
          {word}
        </span>
      );
    })}
  </>
);

/** A line as it is shown: all of it large; or, when it is long, its first sentence large and the rest under it. */
export const shownAs = (
  line: string,
  long = 140
): { title: string; rest: string } => {
  const cut = line.length > long ? line.search(/(?<=[.?!…])\s/u) : -1;
  return cut < 0
    ? { title: line, rest: "" }
    : { title: line.slice(0, cut), rest: line.slice(cut + 1) };
};
