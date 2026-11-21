// How far the tab row's fade reaches in from each side (tabs.tsx): what shows of a tab cut by that
// side, when that is less than half of it, so the fade starts at the tab's own start and the tab
// reads as "more follows", never as cut. Otherwise 0px, and the fade keeps its own width.
import * as stylex from "@stylexjs/stylex";

export const fadeVars = stylex.defineVars({
  start: "0px",
  end: "0px",
});
