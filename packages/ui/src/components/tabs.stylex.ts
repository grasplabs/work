// Tabs' markers and variables (tabs.tsx). The row's marker: while the line glides between tabs, the
// row says so, and the chosen tab's own line gives way to the gliding one. The fade's reach: how far
// the row's fade reaches in from each side, what shows of a tab cut by that side when that is less
// than half of it, so the fade starts at the tab's own start and the tab reads as "more follows",
// never as cut. Otherwise 0px, and the fade keeps its own width.
import * as stylex from "@stylexjs/stylex";

export const tabsRowMarker = stylex.defineMarker();

export const tabsFadeVars = stylex.defineVars({
  start: "0px",
  end: "0px",
});
