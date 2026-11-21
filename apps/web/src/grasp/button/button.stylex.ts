// The button's marker: the parts inside a button (its words, its marks, the spinner) follow the
// button's own state through it (stylex.when.ancestor), without a selector that reaches into
// children. One marker per component, so a button inside another part never answers to that
// part's state.
import * as stylex from "@stylexjs/stylex";

export const buttonMarker = stylex.defineMarker();

// The state on show: a part inside it (a result's mark, its words) arrives when its state is shown,
// through this marker on the state's layer.
export const layerMarker = stylex.defineMarker();
