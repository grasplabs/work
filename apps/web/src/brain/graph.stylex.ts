import * as stylex from "@stylexjs/stylex";

/**
 * The brain's own colours, light and dark (light-dark() follows the theme's
 * colour scheme, as Damsko's tokens do): the hue of each group of notes, as
 * the atlas and a page's names draw them, and the warmth its dots think in.
 * Damsko has no token for them: they are the brain's alone. The hues are the
 * old kit's `--graph-*`, the warmth its `--brain-heat` and `--brain-glow`.
 */
export const graph = stylex.defineVars({
  vision: "light-dark(oklch(0.76 0.14 70), oklch(0.72 0.13 70))",
  teams: "light-dark(oklch(0.72 0.13 150), oklch(0.68 0.12 150))",
  tools: "light-dark(oklch(0.7 0.12 250), oklch(0.68 0.12 250))",
  statements: "light-dark(oklch(0.78 0.1 355), oklch(0.72 0.1 355))",
  candidates: "light-dark(oklch(0.64 0.16 300), oklch(0.66 0.15 300))",
  sources: "light-dark(oklch(0.82 0.01 286), oklch(0.5 0.01 286))",
  gaps: "light-dark(oklch(0.7 0.1 195), oklch(0.68 0.1 195))",
  /** The brain's warmth: the dots that are thinking; never words, never a fill of its own. */
  heat: "light-dark(oklch(0.627 0.183 36.26), oklch(0.68 0.19 38))",
  /** The hottest dots in a drawing, blended from the warmth; the same at night. */
  glow: "oklch(0.843 0.135 83.03)",
});
