// What a Page column's parts read from the column they are in.
import * as stylex from "@stylexjs/stylex";

export const pageColumnVars = stylex.defineVars({
  /** The column's width at most: its `measure`, set by the column. */
  measure: "45rem",
  /**
   * How far a wide child steps back to the frame's start: the centred column's own side, so the
   * child runs the frame's whole width. 0 in a column at the page's start.
   */
  wideStart: "0px",
});
