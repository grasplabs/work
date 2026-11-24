import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// A step's ways on, under a centred title and line: its buttons in one
// centred row, the lesser way before the main one, and a third way, a
// link, centred on a line of its own under them, so the step keeps one
// axis from its title down (Ruben, 24 November).

const styles = stylex.create({
  ways: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space[4],
  },
  buttons: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space[3],
  },
});

export const StepWays = ({
  buttons,
  link,
}: {
  /** The lesser way first, the main one last. */
  buttons: ReactNode;
  /** A third way, a link Button; none where the step has none. */
  link?: ReactNode;
}) => (
  <div {...stylex.props(styles.ways)}>
    <div {...stylex.props(styles.buttons)}>{buttons}</div>
    {link}
  </div>
);
