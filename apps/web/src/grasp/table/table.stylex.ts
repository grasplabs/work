// What a Table reads from what holds it.
import * as stylex from "@stylexjs/stylex";

export const tableVars = stylex.defineVars({
  /**
   * The corner of the table's box. A part that holds a Table flush to its own edges (a Section
   * card's flush body) sets it to 0, so the box is square there and its corners clip nothing of
   * the part around it (a soft head's grey was notched at both top corners).
   */
  corner: "var(--grasp-corner-mark)",
});
