// The attachment strip's fades (attachments.tsx): how far each side's fade reaches, and the band at
// its very edge that shows only the ground, set from the strip's scroll as cards pass its sides.
// Physical sides, left and right, as the mask is drawn left to right in either direction.
import * as stylex from "@stylexjs/stylex";

export const stripVars = stylex.defineVars({
  left: "0px",
  leftClear: "0px",
  right: "0px",
  rightClear: "0px",
});
