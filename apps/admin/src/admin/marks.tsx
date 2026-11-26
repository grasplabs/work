/**
 * Words with a mark before them, drawn with Damsko's tokens: what needs
 * someone (`Attention`, the warning's dot) and what is in place (`Done`,
 * a check in the success colour). The Damsko counterparts of parts.tsx's
 * `Attention` and `Done`, which the pages still on the kit keep until
 * their area moves.
 */
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  attention: { display: "flex", alignItems: "baseline", gap: space["2"] },
  dot: {
    width: "0.375rem",
    height: "0.375rem",
    flexShrink: 0,
    borderRadius: "50%",
    backgroundColor: colors.warning,
    transform: "translateY(-1px)",
  },
  words: { minWidth: 0 },
  done: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    color: colors.mutedForeground,
  },
  check: { display: "inline-flex", flexShrink: 0, color: colors.success },
});

/** What needs someone, in words: the warning's dot, then the words in the text's colour. */
export const Attention = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.attention)}>
    <span aria-hidden {...stylex.props(styles.dot)} />
    <span {...stylex.props(styles.words)}>{children}</span>
  </span>
);

/** Something that is in place: a check and a word, in the success colour. */
export const Done = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.done)}>
    <span aria-hidden {...stylex.props(styles.check)}>
      <Icon icon={CheckIcon} />
    </span>
    {children}
  </span>
);
