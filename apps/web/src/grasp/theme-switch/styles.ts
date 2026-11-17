// The Theme switch's look, in its three forms. Every value is a token (src/tokens); the shared
// focus ring is src/focus.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const REDUCED = media.reduced;
const FORCED = media.forced;
const HOVER = media.hover;
const COARSE = media.coarse;

export const switchStyles = stylex.create({
  root: {
    display: "grid",
    gap: grasp.space4,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  rootInline: { display: "inline-flex" },

  // ---- The icon button: 28 or 32px, the three icons in one cell ----
  icon: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    padding: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: grasp.cornerPill,
    color: grasp.ink,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
      ":active": grasp.ghostFillPress,
    },
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    WebkitTapHighlightColor: "transparent",
  },
  iconSm: { width: grasp.controlXs, height: grasp.controlXs },
  iconMd: { width: grasp.controlSm, height: grasp.controlSm },
  // A finger's 44px, unseen, on a touch screen, from the button's own size.
  target: {
    position: "absolute",
    inset: { default: 0, [COARSE]: `calc((100% - ${grasp.tap}) / 2)` },
  },
  // The shown icon is sharp; the others blurred, a little small, and gone.
  swap: {
    gridArea: "1 / 1",
    display: "flex",
    transitionProperty: "opacity, filter, transform",
    transitionDuration: simply.swap,
    transitionTimingFunction: grasp.ease,
  },
  swapOut: {
    opacity: 0,
    filter: { default: grasp.swapBlur, [REDUCED]: "none" },
    transform: { default: `scale(${grasp.swapScale})`, [REDUCED]: "none" },
  },
  swapIn: { opacity: 1, filter: "none", transform: "none" },

  // ---- The segmented control: three equal segments, the pill moves by a whole segment ----
  segments: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "inline-grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    padding: grasp.space1,
    backgroundColor: grasp.ghostFillHover,
    borderRadius: grasp.cornerPill,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  pill: {
    position: "absolute",
    insetBlock: grasp.space1,
    insetInlineStart: grasp.space1,
    width: `calc((100% - 2 * ${grasp.space1}) / 3)`,
    backgroundColor: grasp.raised,
    borderRadius: grasp.cornerPill,
    boxShadow: grasp.liftLow,
    // In forced colours the fill is dropped: the chosen segment is ringed in the system's highlight.
    borderWidth: { default: 0, [FORCED]: 2 },
    borderStyle: "solid",
    borderColor: "Highlight",
    boxSizing: "border-box",
    transitionProperty: "transform",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  pill0: { transform: "translateX(0)" },
  // The pill starts at the inline start; in right to left that is the right, so it moves left.
  pill1: {
    transform: {
      default: "translateX(100%)",
      ":dir(rtl)": "translateX(-100%)",
    },
  },
  pill2: {
    transform: {
      default: "translateX(200%)",
      ":dir(rtl)": "translateX(-200%)",
    },
  },
  segment: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space1,
    minHeight: { default: grasp.controlXs, [COARSE]: grasp.tap },
    paddingInline: grasp.space3,
    borderWidth: 0,
    backgroundColor: "transparent",
    borderRadius: grasp.cornerPill,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: "color",
    transitionDuration: simply.hover,
    WebkitTapHighlightColor: "transparent",
  },
  segmentOn: { color: grasp.ink },
  // The radio itself: native, so the browser gives the keys (arrows, Home, End, right to left) and
  // a screen reader its place in the group. It covers its label, unseen; the label draws it.
  native: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    margin: 0,
    opacity: 0,
    cursor: "pointer",
  },

  // ---- The picker: a row of mode tiles, a row of theme tiles ----
  group: { display: "grid", gap: grasp.space2, minWidth: 0 },
  groupLabel: {
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  tiles: {
    display: "grid",
    // Two a row on a phone: one a row, a tile grew to a tall box with its miniature in the top third.
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 7.5rem), 1fr))",
    gap: grasp.space4,
    minWidth: 0,
  },
  tile: {
    // Its radio covers it, and only it.
    position: "relative",
    display: "grid",
    alignContent: "start",
    gap: grasp.space2,
    minWidth: 0,
    // Room at its foot, so its focus ring (on its edge) passes under the words, not through them.
    padding: 0,
    paddingBlockEnd: grasp.space2,
    borderWidth: 0,
    backgroundColor: "transparent",
    borderRadius: grasp.corner,
    textAlign: "start",
    fontFamily: grasp.fontSans,
    color: grasp.ink,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  // The miniature's frame, in the page's own theme: it holds the selected mark (ring and badge), so
  // the mark reads the same on every tile, in light and dark, whatever the miniature draws. It
  // stands the miniature in by a ring and a gap, so the tile's focus ring (on the frame's edge)
  // passes clear of the selection ring, never on top of it.
  frame: {
    position: "relative",
    display: "grid",
    padding: grasp.space1,
    pointerEvents: "none",
  },
  // The selection ring: 2px of the page's ink round the miniature, 2px clear of the focus ring.
  ring: {
    position: "absolute",
    inset: grasp.space1,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: `0 0 0 2px ${grasp.ink}`,
  },
  // The miniature: the theme's own ground, a sidebar with its current row raised, a card with
  // lines, the main action and the light, drawn in that theme's tokens on its own element.
  mini: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "28% 1fr",
    // A picture: the pointer passes through to the tile's radio under it.
    pointerEvents: "none",
    aspectRatio: "16 / 10",
    overflow: "hidden",
    backgroundColor: grasp.paper,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    transitionProperty: "box-shadow",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  // In forced colours the shadows are dropped: the chosen miniature is edged in the system's highlight.
  miniOn: {
    borderWidth: { default: 0, [FORCED]: 3 },
    borderColor: { default: "CanvasText", [FORCED]: "Highlight" },
  },
  // The System tile: two halves cut on the diagonal, each a layer of its own over no ground, so no
  // light ground lies under the dark half to show through at the miniature's rounded edge. The
  // light half reaches 2px past the diagonal, under the dark one, so the cut has no seam either.
  // Square, edgeless layers: the miniature's own corner clips them once.
  miniSystem: { backgroundColor: "transparent" },
  half: {
    position: "absolute",
    inset: 0,
    borderRadius: 0,
    boxShadow: "none",
    borderWidth: 0,
    transitionProperty: "none",
  },
  halfLight: {
    clipPath: "polygon(0 0, calc(100% + 2px) 0, 0 calc(100% + 2px))",
  },
  halfDark: { clipPath: "polygon(100% 0, 100% 100%, 0 100%)" },
  side: {
    display: "grid",
    alignContent: "start",
    gap: grasp.space1,
    padding: grasp.space2,
    backgroundColor: grasp.soft,
  },
  main: {
    display: "grid",
    alignContent: "start",
    gap: grasp.space2,
    padding: grasp.space2,
  },
  card: {
    display: "grid",
    gap: grasp.space1,
    padding: grasp.space2,
    backgroundColor: grasp.raised,
    borderRadius: grasp.cornerMark,
    boxShadow: grasp.liftLow,
  },
  bar: {
    height: grasp.space1,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.quiet,
  },
  barInk: { backgroundColor: grasp.ink },
  barCurrent: {
    height: grasp.space2,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
  },
  w80: { width: "80%" },
  w60: { width: "60%" },
  w45: { width: "45%" },
  foot: { display: "flex", alignItems: "center", gap: grasp.space1 },
  action: {
    width: grasp.space6,
    height: grasp.space2,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.actionFill,
  },
  light: {
    width: grasp.space2,
    height: grasp.space2,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.mint,
  },
  tick: {
    [iconVars.size]: grasp.checkboxMark,
    position: "absolute",
    // The miniature's corner, in from the frame's padding.
    insetBlockStart: `calc(2 * ${grasp.space1})`,
    insetInlineEnd: `calc(2 * ${grasp.space1})`,
    display: "grid",
    placeItems: "center",
    width: grasp.checkboxBox,
    height: grasp.checkboxBox,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.actionFill,
    color: grasp.actionText,
    // A ring of the page's ground, as wide as the gap the selection ring keeps, so the badge is cut
    // out of whatever the miniature draws behind it (the System tile's light half in dark).
    boxShadow: `0 0 0 ${grasp.ringOffsetMark} ${grasp.paper}`,
  },
  // The words stand in line with the miniature's inside, clear of the tile's focus ring.
  name: {
    paddingInline: grasp.space3,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
  },
  line: {
    paddingInline: grasp.space3,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
});
