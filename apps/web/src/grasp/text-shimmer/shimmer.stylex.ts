// What a shimmering line's light reads from the line (text-shimmer.tsx): how wide the band is, how
// long one pass takes, and whether it plays.
import * as stylex from "@stylexjs/stylex";

export const shimmerVars = stylex.defineVars({
  /** The band's width, in the text's own characters. */
  band: "5ch",
  /** One pass and the rest after it. */
  pass: "2000ms",
  /** `running`, or `paused` while the line is off screen. */
  play: "running",
});
