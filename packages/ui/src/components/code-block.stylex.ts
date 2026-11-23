// CodeBlock's mask (code-block.tsx): the height a block folds at, set per block from its
// `maxLines`, and how far each faded edge reaches: the foot while it is folded, and the start and
// the end while there is more beyond them sideways. A page with no script leaves it unfolded. And
// the line numbers' width, as wide as the widest number.
import * as stylex from "@stylexjs/stylex";

export const codeBlockVars = stylex.defineVars({
  height: "none",
  foot: "0px",
  start: "0px",
  end: "0px",
  digits: "1ch",
});
