// Where the margin's rule and its note stand, set by the prose that holds them (margin.tsx): how far
// from the prose's end the rule stands, and how wide the note's column is.
import * as stylex from "@stylexjs/stylex";

export const marginVars = stylex.defineVars({
  /** From the end of the box that places it to the rule: in the gap before the note's column. */
  ruleEnd: "0px",
  /** From the end of the box that places it to the note. */
  noteEnd: "0px",
  /** The note's column: as wide as a source's name, a date and a citation. */
  noteSize: "0px",
});
