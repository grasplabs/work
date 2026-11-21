// What a Section header reads from what holds it.
import * as stylex from "@stylexjs/stylex";

export const sectionHeaderVars = stylex.defineVars({
  /**
   * The room the actions give back above themselves while they stand on the title's line. A grouped
   * Section card sets it so an xs button's foot meets the foot of the title's line: the head ends
   * there, and its card stands 8px under it as under a sentence. A taller control keeps its whole
   * box under the line, and the card stands 8px under that. 0 everywhere else.
   */
  actionsTrim: "0px",
});
