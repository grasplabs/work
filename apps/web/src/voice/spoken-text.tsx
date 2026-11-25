import { colors, duration } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { wordsOf } from "./timing.ts";
import { useSaid } from "./voice.ts";

// Text that lights up word by word as Stephen says it (prototype
// `components/onboarding/spoken-text.tsx`), as in Eleven v4's own demo.

const styles = stylex.create({
  word: {
    transitionProperty: "color",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  rest: {},
  said: { color: colors.foreground },
  // The word being said: the brand's deep mint, as #2503's.
  saying: { color: colors.mintDeep },
  waiting: { color: colors.mutedForeground },
});

type WordState = "rest" | "said" | "saying" | "waiting";

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
 * said, the words said are in ink, the word being said in mint and the
 * rest waiting in grey; once it is over, every word eases back to the text
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
          key={start}
          {...stylex.props(
            styles.word,
            styles[stateOf(said, from + start, from + end)]
          )}
        >
          {word}
        </span>
      ))}
    </>
  );
};
