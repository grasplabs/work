// What a Panel's parts read from where the Panel stands.
import * as stylex from "@stylexjs/stylex";

export const panelVars = stylex.defineVars({
  /**
   * The ground the panel's sticky bar and views strip are drawn on, so what scrolls under them is
   * covered: the panel's own raised ground, or, seated in App shell's page panel, the shell card's.
   */
  ground: "var(--grasp-raised)",
});
