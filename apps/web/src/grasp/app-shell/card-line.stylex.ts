// How wide a shell card's edge line is, set by the card in each of its states and read by the line
// drawn over what the card holds (card-line.tsx). 0 where the card has no line (a phone's window,
// panels lying full screen on the page's card).
import * as stylex from "@stylexjs/stylex";

export const cardLine = stylex.defineVars({ width: "0px" });
