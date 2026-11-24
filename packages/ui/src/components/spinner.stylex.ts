// The values a part round a Spinner may set: how faint its last bars go (spinner-fade by default),
// and how heavy its stroke is (icon-stroke).
import * as stylex from "@stylexjs/stylex";

import { size } from "../lib/tokens.stylex";

export const spinnerVars = stylex.defineVars({
  /** How faint the last bar goes, 0 to 1. */
  floor: size.spinnerFade,
  /** The ring's stroke, in the icon's 24-unit grid. */
  stroke: size.iconStroke,
});
