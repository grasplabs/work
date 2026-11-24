// Concepts only: a sentence that lights up word by word as the page
// arrives, as Stephen's lines did in the onboarding (voice/spoken-text.tsx):
// the words read in ink, those still to come waiting in grey. Each word's
// change is over in 200ms; with reduced motion it stands lit at once.
// Damsko has no part for text that is read out, so it is the feature's.
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, duration, media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

const styles = stylex.create({
  word: {
    transitionProperty: "color",
    transitionDuration: { default: duration.ui, [media.reducedMotion]: "0s" },
    transitionTimingFunction: duration.ease,
  },
  waiting: { color: colors.mutedForeground, opacity: 0.45 },
  read: { color: "inherit" },
});

/** How long a word takes to read, in ms. */
const perWord = 110;

/** `text`, lighting up a word at a time from when it is first shown. */
export const ReadAloud = ({ text }: { text: string }) => {
  const words = text.split(" ");
  const [read, setRead] = useState(() =>
    matchMedia("(prefers-reduced-motion: reduce)").matches ? words.length : 0
  );
  useEffect(() => {
    const next =
      read >= words.length
        ? undefined
        : setTimeout(() => {
            setRead(read + 1);
          }, perWord);
    return () => {
      clearTimeout(next);
    };
  }, [read, words.length]);
  return (
    <span>
      <span {...stylex.props(visuallyHidden)}>{text}</span>
      {words.map((word, index) => (
        <span
          aria-hidden
          key={index}
          {...stylex.props(
            styles.word,
            index < read ? styles.read : styles.waiting
          )}
        >
          {index === words.length - 1 ? word : `${word} `}
        </span>
      ))}
    </span>
  );
};
