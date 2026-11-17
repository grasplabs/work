// What App building's parts read from the stage round them (app-building.tsx): whether the build
// plays. `paused` while the stage is off screen or its tab is hidden, so nothing runs unseen.
import * as stylex from "@stylexjs/stylex";

export const buildVars = stylex.defineVars({
  /** `running`, or `paused` while the stage is off screen or its tab is hidden. */
  play: "running",
});
