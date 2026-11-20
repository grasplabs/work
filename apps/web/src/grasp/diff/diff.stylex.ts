// A row's tint, handed to its pinned cells: with lines kept whole the line numbers and the mark stay
// at the start while the words scroll under them, so those cells lay the row's tint over the box's
// own ground and hide what passes beneath.
import * as stylex from "@stylexjs/stylex";

export const diffVars = stylex.defineVars({
  tint: "transparent",
});
