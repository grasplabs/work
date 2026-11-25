import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

// The pause before the answers of something that came into the place of
// one just answered can be used: the Inbox's item that opens after an
// answer (inbox-page.tsx), and the cards that wait on the person in the
// chat (chat/waiting-for-you.tsx), which move up into the place of one
// answered. Longer than a double click, so the second press, meant for
// what was answered, never answers what is now under the pointer: an
// outside write, a grant, packages the person never read.

/** How long the answers stay out of use: longer than a double click. */
const arrivalPauseMs = 1000;

/**
 * Whether the answers may be used: at once, or, `arriving` in place of
 * something just answered, after `arrivalPauseMs`; and what holds them
 * for the pause again, from now, once an answer moved others into place.
 */
export const useArmed = (
  arriving: boolean
): readonly [armed: boolean, hold: () => void] => {
  // Each hold counted, and the last whose pause is over: a hold while one
  // runs starts the pause again.
  const [holds, setHolds] = useState(arriving ? 1 : 0);
  const [over, setOver] = useState(0);
  const armed = over === holds;
  useEffect(() => {
    const timer = armed
      ? undefined
      : setTimeout(() => {
          setOver(holds);
        }, arrivalPauseMs);
    return () => {
      clearTimeout(timer);
    };
  }, [armed, holds]);
  return [
    armed,
    () => {
      setHolds((count) => count + 1);
    },
  ];
};

/**
 * The pause a list of answers shares, handed to each of them: whether
 * they are held now, and what holds them all once one is answered.
 */
export interface AnswersPause {
  readonly held: boolean;
  readonly hold: () => void;
}

/** A pause for a list of answers, usable at first (`useArmed`). */
export const useAnswersPause = (): AnswersPause => {
  const [armed, hold] = useArmed(false);
  return { held: !armed, hold };
};

/**
 * The pause, said to a screen reader: what the answers it holds are
 * described by (`aria-describedby`), each staying a Tab stop that says so.
 */
export const PauseNote = ({ id }: { id: string }) => {
  const { t } = useLingui();
  return (
    <span id={id} {...stylex.props(visuallyHidden)}>
      {t`Its answers can be used in a moment, so a press meant for the one before doesn't answer it.`}
    </span>
  );
};
