// What a Field's parts read from the Field and the FieldGroup round them. Its marker, which the
// controls inside it answer, is fieldControlMarker in lib/vars.stylex.ts.
import * as stylex from "@stylexjs/stylex";

import { size } from "../lib/tokens.stylex";

/**
 * A responsive Field's columns: its words, and the control column every control fills, or each
 * control at its own width on the end edge (FieldGroup `controls="fit"`); and how a row narrower
 * than 34rem stands: the control under the words (a grid), or still beside them while the name
 * keeps its floor (a wrapping line).
 */
export const fieldVars = stylex.defineVars({
  columns: `minmax(0, 1fr) ${size.fieldControlColumn}`,
  columnsNarrow: "minmax(0, 1fr)",
  displayNarrow: "grid",
});
