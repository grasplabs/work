// What a shimmering line's light reads from the line (shimmer.tsx): how wide the band is, how long
// one pass takes, and whether it plays. The line sets the first two from its variant and its length.
import * as stylex from "@stylexjs/stylex";

import { duration } from "../lib/tokens.stylex";

export const shimmerVars = stylex.defineVars({
  /** The band's width, in the text's own characters. */
  band: "5ch",
  /** One pass and the rest after it. */
  pass: duration.work,
  /** `running`, or `paused` while the line is off screen. */
  play: "running",
});
