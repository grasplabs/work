// The field's marker: its label follows what is inside the field through it (stylex.when.ancestor),
// such as a required control, without a selector that reaches into children. One marker per
// component, so a label never answers to another part's state.
import * as stylex from "@stylexjs/stylex";

export const fieldMarker = stylex.defineMarker();
