// The field's marker: its icons, its value and its press area follow the field's own state
// (data-copied, data-more) through it (stylex.when.ancestor), with no selector that reaches into
// children. One marker per component, so a field inside another part never answers to that part.
import * as stylex from "@stylexjs/stylex";

export const copyFieldMarker = stylex.defineMarker();
