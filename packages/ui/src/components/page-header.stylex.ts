// What a banner PageHeader reads from the page it stands in: a shell's page publishes its own
// padding here, its top and its sides, so the banner can take them back and stand flush under the
// bar, edge to edge. Outside a shell both are 0 and the banner stays where it is.
import * as stylex from "@stylexjs/stylex";

export const pageBandVars = stylex.defineVars({
  /** The room the page keeps above its first child. */
  top: "0px",
  /** The room the page keeps at its sides. */
  inline: "0px",
});
