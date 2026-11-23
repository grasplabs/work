import { Icon } from "@grasp-os/ui/lib/icons";
import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";

import { GraspMark } from "../frame/grasp-mark.ts";

// Grasp's mark, as the interview's link shows it: in the corner of the
// frame, and over what the page says when there is no interview to show.

const styles = stylex.create({
  mark: { display: "flex", flexShrink: 0, color: colors.foreground },
  default: { [iconVars.size]: "1.25rem" },
  lg: { [iconVars.size]: "1.5rem" },
});

export const Mark = ({ size = "default" }: { size?: "default" | "lg" }) => (
  <span {...stylex.props(styles.mark, styles[size])}>
    <Icon icon={GraspMark} />
  </span>
);
