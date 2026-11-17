// Sources' marker: the pile's marks fan out when the pile under them is hovered (stylex.when.ancestor).
import * as stylex from "@stylexjs/stylex";

export const pileMarker = stylex.defineMarker();

/**
 * The pile's fan, in steps of source-pile-fan: `at`, how many steps a mark moves (its place in the
 * pile, from 0); `spread`, the steps the last one moves, which the count follows.
 */
export const pileVars = stylex.defineVars({ at: "0", spread: "0" });
