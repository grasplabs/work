// The choice row's marker and the colours its box draws. The marker sits on the row, so a box or
// a track follows a pointer over the whole row (its words included) through stylex.when.ancestor,
// without a selector that reaches into children. Rows never nest, so one marker serves Checkbox,
// Radio and Switch.
//
// The button sets the colours from its own state (a pointer on the row, an error) and the face
// inside it reads them, so no rule reaches from one into the other.
import * as stylex from "@stylexjs/stylex";

export const choiceMarker = stylex.defineMarker();

export const choiceVars = stylex.defineVars({
  /** The edge an empty box or circle draws. */
  edge: "transparent",
  /** The danger line round a checked box or chosen circle that is wrong. */
  wrong: "transparent",
});
