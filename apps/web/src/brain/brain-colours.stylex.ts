import * as stylex from "@stylexjs/stylex";

// The Brain's two warm lights, the product's own colours (Damsko's palette
// has the brand's seven, not these): its heat, where a part of the Brain is
// busy, and its glow. Kept once, here: the Brain's pictures draw with them,
// and so do the agents' warm figures (agents/figure/look.ts, ember and
// amber). The heat is a step brighter on a dark page.
export const brainColors = stylex.defineVars({
  heat: "light-dark(oklch(0.627 0.183 36.26), oklch(0.68 0.19 38))",
  glow: "oklch(0.843 0.135 83.03)",
});
