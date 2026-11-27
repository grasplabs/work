// The app shell's variables and markers. StyleX resolves them only when imported straight from a
// .stylex.ts file, so they live here, beside the shell's parts.
import * as stylex from "@stylexjs/stylex";

export const appShellVars = stylex.defineVars({
  /**
   * Room kept at the end of the page's bar beyond its own, for what a product lays over the card's
   * end at the bar's height (a button of its own). Set it on an element round the page.
   */
  barEndRoom: "0px",
  /**
   * Room kept under the page in its scroller (AppShellContent), for what a product lays over the
   * card's foot (a dock), so the page's end scrolls clear of it. For a page that fills the card:
   * AppShellPage keeps room below of its own. Set it on an element round the page.
   */
  contentRoomBelow: "0px",
});

/** The switch's track, marked so its thumb and tabs follow whether the thumb stands (`data-thumb`). */
export const switchMarker = stylex.defineMarker();
