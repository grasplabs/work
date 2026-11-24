// What App building's parts read from the stage round them (app-building.tsx): whether the build
// plays, `paused` while the stage is off screen or its tab is hidden, so nothing runs unseen; and
// its own values, built from Damsko's tokens.
import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

export const buildVars = stylex.defineVars({
  /** `running`, or `paused` while the stage is off screen or its tab is hidden. */
  play: "running",
});

export const appBuilding = stylex.defineVars({
  /** The least room the build takes: an App's frame, at its smallest. */
  minHeight: "320px",
  /** One step of the build: a cursor's travel, its press and a piece coming in, each move 300ms at most. */
  beat: "760ms",
  /** The grid of the dither on a block: one dot in every 4px square. */
  dither: "4px",
  /** A block of the interface being built: pine, faint. */
  block: `color-mix(in oklch, ${colors.pine} 9%, transparent)`,
  /** The lines and bars inside a block. */
  detail: `color-mix(in oklch, ${colors.pine} 22%, transparent)`,
  /** A dot of the dither on a block or a bar. */
  dot: `color-mix(in oklch, ${colors.pine} 30%, transparent)`,
  /** A cursor's name on its tag: light on the cursor's colour, dark on its lifted colour in dark. */
  onCursor: `light-dark(${colors.brandPaper}, ${colors.brandNight})`,
});
