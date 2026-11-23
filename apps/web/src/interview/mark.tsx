import { filledMark, Icon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";

// Grasp's mark, as the interview's link shows it: in the corner of the
// frame, and over what the page says when there is no interview to show.
// A brand's mark is the product's, not Damsko's (lib/icons.ts): its four
// parts as one path on their 29.2 by 24.7 grid, centred in Damsko's 24
// grid, in the ink.

const grasp: IconData = filledMark([
  [
    "path",
    {
      d: "M5.73655 0L4.92188 4.55021H26.6572L27.4668 0H5.73655ZM15.1424 6.70117H2.0083L1.19531 11.2497H14.3277L15.1424 6.70117ZM13.9454 13.4023H0.812992L0 17.9509H13.1324L13.9454 13.4023ZM17.5191 6.70117L15.5077 17.9794H20.1365L21.3366 11.2497H23.6982L22.1193 20.1056H2.148L1.33838 24.6524H25.9352L29.1383 6.70117H17.5191Z",
      fill: "currentColor",
      transform: "translate(0 1.85) scale(0.8219)",
    },
  ],
]);

const styles = stylex.create({
  mark: { display: "flex", flexShrink: 0, color: colors.foreground },
  default: { [iconVars.size]: "1.25rem" },
  lg: { [iconVars.size]: "1.5rem" },
});

export const Mark = ({ size = "default" }: { size?: "default" | "lg" }) => (
  <span {...stylex.props(styles.mark, styles[size])}>
    <Icon icon={grasp} />
  </span>
);
