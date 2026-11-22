// The button's marker: the parts inside a button (its sheen) follow the button's own hover and
// press through it (stylex.when.ancestor), without a selector that reaches into children. One
// marker per component, so a button inside another part never answers to that part's state.
import * as stylex from "@stylexjs/stylex";

import { colors } from "../lib/tokens.stylex";

export const buttonMarker = stylex.defineMarker();

/**
 * What a ghost button reads from the part that holds it, as an icon reads `iconVars`. A part that
 * is one surface with a ghost button inside (Snippet's field) answers the pointer and the keyboard
 * itself, and sets these on itself so the button draws no second fill or ring in it:
 * `{ [ghostVars.hover]: "transparent" }`. Never restyle a button from outside.
 */
export const ghostVars = stylex.defineVars({
  /** Its ink. */
  ink: colors.foreground,
  /** Its fill under a pointer. */
  hover: colors.accent,
  /** Its fill while pressed, or held on. */
  active: colors.accentActive,
  /** Its keyboard ring's colour. */
  ring: colors.ring,
});
