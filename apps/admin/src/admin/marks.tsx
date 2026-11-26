/**
 * Words with a mark before them, drawn with Damsko's tokens: what is in
 * place (`Done`, a check in the success colour). The Damsko counterpart of
 * parts.tsx's `Done`, which the pages still on the kit keep until their
 * area moves.
 */
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  done: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    color: colors.mutedForeground,
  },
  check: { display: "inline-flex", flexShrink: 0, color: colors.success },
});

/** Something that is in place: a check and a word, in the success colour. */
export const Done = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.done)}>
    <span aria-hidden {...stylex.props(styles.check)}>
      <Icon icon={CheckIcon} />
    </span>
    {children}
  </span>
);
