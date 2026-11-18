import * as stylex from "@stylexjs/stylex";

import { BrandGrasp } from "../grasp/icons/brands.ts";
import { iconVars } from "../grasp/icons/icon.stylex.ts";
import { Icon } from "../grasp/icons/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// Grasp's mark, as the interview's link shows it: in the corner of the
// frame, and over what the page says when there is no interview to show.

const styles = stylex.create({
  mark: { display: "flex", flexShrink: 0, color: grasp.ink },
  md: { [iconVars.size]: "1.25rem" },
  lg: { [iconVars.size]: "1.5rem" },
});

export const Mark = ({ size = "md" }: { size?: "md" | "lg" }) => (
  <span {...stylex.props(styles.mark, styles[size])}>
    <Icon icon={BrandGrasp} />
  </span>
);
