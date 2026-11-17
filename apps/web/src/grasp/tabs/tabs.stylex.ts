// The row's marker: while the line glides between tabs (src/motion/glide.ts), the row says so, and
// the chosen tab's own line gives way to the gliding one.
import * as stylex from "@stylexjs/stylex";

export const rowMarker = stylex.defineMarker();
