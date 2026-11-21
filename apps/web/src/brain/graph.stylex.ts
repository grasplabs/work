import * as stylex from "@stylexjs/stylex";

/**
 * The brain's own hue for each group of notes, as the atlas and a page's
 * names draw them, light and dark (light-dark() follows the theme's colour
 * scheme, as Grasp UI's tokens do). The library has no token for them: they
 * are the brain's alone. The values are the old kit's `--graph-*`.
 */
export const graph = stylex.defineVars({
  vision: "light-dark(oklch(0.76 0.14 70), oklch(0.72 0.13 70))",
  teams: "light-dark(oklch(0.72 0.13 150), oklch(0.68 0.12 150))",
  tools: "light-dark(oklch(0.7 0.12 250), oklch(0.68 0.12 250))",
  statements: "light-dark(oklch(0.78 0.1 355), oklch(0.72 0.1 355))",
  candidates: "light-dark(oklch(0.64 0.16 300), oklch(0.66 0.15 300))",
  sources: "light-dark(oklch(0.82 0.01 286), oklch(0.5 0.01 286))",
  gaps: "light-dark(oklch(0.7 0.1 195), oklch(0.68 0.1 195))",
});
