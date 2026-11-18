// A tint's two colours, set once on a part and read by what is inside it (tone.ts): the ink, for a
// dot, a bar or a label's words; and the wash, a soft ground behind words. And the turn's marker,
// so a highlight inside a turn is washed while the pointer or keyboard focus is on its turn.
import * as stylex from "@stylexjs/stylex";

export const toneVars = stylex.defineVars({
  /** The strong colour: holds 4.5:1 as words on the page's ground, light and dark. */
  ink: "currentColor",
  /** The soft ground: the page's words hold 4.5:1 on it. */
  wash: "transparent",
  /** Half the ink in the ground: a speaker's quiet stretch on the timeline, and their portrait's ring. */
  mid: "transparent",
});

/**
 * On a transcript's table marked in its margin: the margin's rules and words show only once the
 * table says they were placed where they belong (`data-margin="placed"`); until then, and for good
 * where they were not, the highlights are underlined with their kinds after them.
 */
export const marginMarker = stylex.defineMarker();

/** On a transcript's turn: its highlights read the turn's hover and focus through it. */
export const turnMarker = stylex.defineMarker();
