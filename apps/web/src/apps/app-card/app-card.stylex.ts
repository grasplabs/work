// The App card's marker and its own values: the frame lifts and rings when the card is hovered or
// its link has focus. The values are the card's alone, so they live beside it, not in Damsko's
// tokens; each is built from Damsko's.
import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

export const cardMarker = stylex.defineMarker();

/** The card's own measures and shadows. */
export const appCard = stylex.defineVars({
  /** The frame: as wide as a laptop's screen, so a window of app fits with its crop. */
  ratio: "16 / 10",
  /** The frame's tallest: past this the window is cropped lower by the frame's foot. */
  frameMax: "20rem",
  /** The frame's corner, a squircle: larger than a card's, the frame is the picture. */
  corner: "28px",
  /** The app window's top corners inside the frame. */
  windowCorner: "14px",
  /** How far the window stands in from the frame's top and sides: a share of the frame's width. */
  inset: "6cqi",
  /** The window standing on its ground. */
  windowLift: `0 0 0 1px ${colors.borderStrongColor}, 0 1px 2px ${colors.shadowColorFaint}, 0 14px 36px -10px ${colors.shadowColorSoft}`,
  /** The frame's own edge, inside it, so a pale ground keeps its rim on paper. */
  frameEdge: `inset 0 0 0 1px ${colors.borderStrongColor}`,
  /** The frame lifted under the pointer. */
  frameLift: `inset 0 0 0 1px ${colors.borderStrongColor}, 0 12px 28px -14px ${colors.shadowColorSoft}`,
  /** How far the frame rises under the pointer. */
  rise: "-2px",
});
