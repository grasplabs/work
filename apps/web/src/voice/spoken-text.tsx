import { wordsOf } from "./timing.ts";
import { useSaid } from "./voice.ts";

// Text that lights up word by word as Stephen says it (prototype
// `components/onboarding/spoken-text.tsx`), as in Eleven v4's own demo.

const wordClass = {
  rest: "transition-colors duration-700",
  said: "text-foreground transition-colors duration-300",
  saying: "text-brain-heat transition-colors duration-150",
  waiting: "text-muted-foreground/60 transition-colors duration-300",
} as const;

type WordState = keyof typeof wordClass;

const stateOf = (said: number, first: number, last: number): WordState => {
  if (said < 0) {
    return "rest";
  }
  if (said >= last) {
    return "said";
  }
  return said > first ? "saying" : "waiting";
};

/**
 * `text` as part of the line `line`, from `from` in it: while the line is
 * said, the words said are in ink, the word being said warm and the rest
 * waiting in grey; once it is over, every word eases back to the text
 * around it.
 */
export const SpokenText = ({
  line,
  from,
  text,
}: {
  line: string;
  from: number;
  text: string;
}) => {
  const said = useSaid(line);
  return (
    <>
      {wordsOf(text).map(({ word, start, end }) => (
        <span
          className={wordClass[stateOf(said, from + start, from + end)]}
          key={start}
        >
          {word}
        </span>
      ))}
    </>
  );
};
