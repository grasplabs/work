// What a Section header reads from what holds it.
import * as stylex from "@stylexjs/stylex";

export const sectionHeaderVars = stylex.defineVars({
  /**
   * The room the actions give back above and below themselves while they stand on the title's
   * line. A grouped Section card sets it so a small button is no taller than the title's line, and
   * its card stands as far under "Plan" with an action as under a sentence (0 everywhere else).
   */
  actionsTrim: "0px",
});
