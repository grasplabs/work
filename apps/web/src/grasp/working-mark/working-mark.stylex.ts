// What the working mark's parts read from the mark around them (working-mark.tsx): whether it
// plays, and the dither path's loop and step.
import * as stylex from "@stylexjs/stylex";

export const markVars = stylex.defineVars({
  /** `running`, or `paused` while the mark is off screen or its tab is hidden. */
  play: "running",
  /** One loop of the dither glyph's path. */
  loop: "1600ms",
  /** How far behind each dot of the path lights after the one before. */
  step: "130ms",
});
