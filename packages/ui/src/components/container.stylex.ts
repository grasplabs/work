// What a Container's parts read from the container they are in.
import * as stylex from "@stylexjs/stylex";

export const containerVars = stylex.defineVars({
  /** The column's width at most: its `size`, set by the container. */
  measure: "45rem",
  /**
   * How far a bleeding child steps back to the frame's start: the centred column's own side, so the
   * child runs the frame's whole width. 0 in a container at the page's start.
   */
  bleedStart: "0px",
});
