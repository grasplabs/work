// What a SectionHeader's actions read from the header round them.
import * as stylex from "@stylexjs/stylex";

export const sectionHeaderVars = stylex.defineVars({
  /**
   * The room the actions give back above themselves while they stand on the title's line. A
   * `group` header sets it, so an xs button's foot meets the foot of the title's line: the head
   * ends there, and the card under it stands its gap under both, as under a sentence. 0 for a
   * `section` header.
   */
  actionsTrim: "0px",
});
