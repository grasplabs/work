// What a banner Alert reads from where it stands: a shell that lays it across its card's top, as a
// band, sets its corner to 0, so its square ends meet the card's edges; anywhere else it keeps the
// system's corner.
import * as stylex from "@stylexjs/stylex";

export const alertVars = stylex.defineVars({
  /** A banner's corner. */
  bannerCorner: "var(--damsko-radius-xl)",
});
