// How Sidebar's tree guide is drawn (its nested rows), from tokens, set again by what holds it.
import * as stylex from "@stylexjs/stylex";

export const guideVars = stylex.defineVars({
  /** Where the stem stands, from the nested row's start: under its head's start inset. */
  stem: "var(--grasp-shell-row-inline)",
  /** Where the nested row's words start: a branch runs to a step before them. */
  words:
    "calc(var(--grasp-shell-row-inline) + var(--grasp-shell-icon) + var(--grasp-shell-icon-gap))",
  /** The elbow's radius, where a branch leaves the stem; less where a row has less room. */
  radius: "var(--grasp-space-3)",
  /** The stem's and the branches' width. */
  stroke: "var(--grasp-shell-guide)",
  /** The guide's colour. */
  line: "var(--grasp-line)",
  /** The path down to the current row: the line's colour; a host may set it to the ink. */
  path: "var(--grasp-line)",
});
