// The sidebar switch's marker. StyleX resolves a marker only when it is
// imported straight from a .stylex.ts file, so it lives here, beside
// sidebar-switch.tsx.
import * as stylex from "@stylexjs/stylex";

/** The switch's track, marked so its thumb and tabs follow whether the thumb stands (`data-thumb`). */
export const switchMarker = stylex.defineMarker();
