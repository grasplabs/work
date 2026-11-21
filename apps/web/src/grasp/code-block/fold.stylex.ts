// The code's mask (code-block.tsx, styles.ts): the height a block folds at, set per block from its
// `maxLines`, and how far each faded edge reaches: the foot while it is folded, and the start and
// the end while there is more beyond them sideways. A page with no script leaves it unfolded.
import * as stylex from "@stylexjs/stylex";

export const foldVars = stylex.defineVars({
  height: "none",
  foot: "0px",
  start: "0px",
  end: "0px",
});
