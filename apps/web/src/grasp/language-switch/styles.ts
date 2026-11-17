// The Language switch's look, in its three looks. Every value is a token (src/tokens); the shared
// focus ring is src/focus; the menu is the Dropdown menu's own look.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const HOVER = media.hover;
const REDUCED = media.reduced;
const FORCED = media.forced;
const COARSE = media.coarse;

const SCROLLS = "@supports (animation-timeline: scroll())";
// The fade at the foot of a list that goes on: there while there is more below, gone at the end.
const more = stylex.keyframes({
  "0%, 94%": { opacity: 1 },
  "100%": { opacity: 0 },
});
// And at its head, once rows have gone under the search (A3-choice-02): gone at the top.
const moreAbove = stylex.keyframes({
  "0%": { opacity: 0 },
  "6%, 100%": { opacity: 1 },
});

export const styles = stylex.create({
  // A list that scrolls says so: a fade at its foot over the last row while there is more below,
  // as Combobox's and Select's lists do (the list's own scroll drives it). It takes no room.
  more: {
    display: "block",
    position: "sticky",
    insetBlockEnd: 0,
    zIndex: 1,
    height: grasp.space8,
    marginBlockStart: `calc(-1 * ${grasp.space8})`,
    backgroundImage: {
      default: `linear-gradient(to bottom, transparent, ${grasp.raised})`,
      "@media (forced-colors: active)": "none",
    },
    opacity: 0,
    pointerEvents: "none",
    animationName: { default: null, [SCROLLS]: more },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "both" },
    animationTimeline: { default: null, [SCROLLS]: "scroll(nearest)" },
  },
  // The same at the list's head, over the first row in view while rows lie above it.
  moreAbove: {
    display: "block",
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 1,
    height: grasp.space8,
    marginBlockEnd: `calc(-1 * ${grasp.space8})`,
    backgroundImage: {
      default: `linear-gradient(to top, transparent, ${grasp.raised})`,
      "@media (forced-colors: active)": "none",
    },
    opacity: 0,
    pointerEvents: "none",
    animationName: { default: null, [SCROLLS]: moreAbove },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "both" },
    animationTimeline: { default: null, [SCROLLS]: "scroll(nearest)" },
  },
  // The popup (Dropdown menu's panel) holds the search and the list without scrolling itself: the
  // list takes the room left and scrolls, so its foot fade stands on the popup's own foot. With both
  // scrolling, the popup clipped the list's last 48px and its fade with them (A3-choice-02, -04).
  popupFrame: { display: "flex", flexDirection: "column", overflowY: "hidden" },
  // In the popup the list runs to the popup's edges, which clip what stands outside them: its focus
  // ring (focus.within) is drawn just inside its edge, so it shows whole, not as a line under the
  // search (A3-choice-04).
  ringInside: { outlineOffset: `calc(-1 * ${grasp.ringWidth})` },
  root: { display: "inline-flex", minWidth: 0, fontFamily: grasp.fontSans },
  rootList: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    width: "100%",
    maxWidth: "26rem",
  },

  // ---- The compact button: the Button's quiet look, with a flag ----
  trigger: {
    // As wide as its root: its own width with none given, the column's when the root is given one.
    width: "100%",
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    margin: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "ButtonText",
    color: grasp.ink,
    backgroundColor: {
      default: grasp.quietFill,
      ":hover": { default: null, [HOVER]: grasp.quietFillHover },
      ":active": grasp.quietFillPress,
    },
    boxShadow: grasp.bevelQuiet,
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    userSelect: "none",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transform: { default: null, ":active": `scale(${grasp.pressScale})` },
    transitionProperty: "transform, background-color",
    transitionDuration: `${simply.press}, ${grasp.durationHover}`,
    transitionTimingFunction: grasp.ease,
    // A 44px target on a touch screen, whatever the size.
    "::before": {
      content: "''",
      position: "absolute",
      insetBlock: { default: 0, [COARSE]: `calc((100% - ${grasp.tap}) / 2)` },
      insetInline: 0,
    },
  },
  sm: {
    height: grasp.controlXs,
    paddingInlineStart: grasp.space2,
    paddingInlineEnd: grasp.space2,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))`,
  },
  md: {
    height: grasp.controlSm,
    paddingInlineStart: grasp.space3,
    paddingInlineEnd: grasp.space2,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
  },
  chevron: { display: "inline-flex", color: grasp.muted },

  // Every option's flag and name stacked in one cell, only the chosen one seen: the button keeps the
  // width of the widest and never shifts. They change by the Button's blur and fade.
  // It grows when the button is given more room, so the chevron stands at the end.
  stack: {
    display: "inline-grid",
    alignItems: "center",
    justifyItems: "start",
    flexGrow: 1,
  },
  // The popup at least as wide as the button (less the menu panel's own padding, for the menu).
  popupAtLeastTrigger: { minWidth: "var(--anchor-width)" },
  menuAtLeastTrigger: {
    minWidth: `calc(var(--anchor-width) - 2 * ${grasp.popupPadding})`,
  },
  layer: {
    gridArea: "1 / 1",
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    transitionProperty: "opacity, filter, transform, visibility",
    transitionDuration: simply.swap,
    transitionTimingFunction: grasp.ease,
  },
  shown: {
    opacity: 1,
    visibility: "visible",
    filter: "none",
    transform: "none",
  },
  gone: {
    opacity: 0,
    visibility: "hidden",
    filter: { default: grasp.swapBlur, [REDUCED]: "none" },
    transform: { default: `scale(${grasp.swapScale})`, [REDUCED]: "none" },
  },

  // ---- The menu's rows ----
  menuName: { flexGrow: 1, minWidth: 0 },
  menuSecond: {
    color: grasp.muted,
    fontWeight: grasp.weightRegular,
    marginInlineStart: grasp.space2,
  },

  // ---- The list ----
  listBox: {
    boxSizing: "border-box",
    width: "100%",
    padding: grasp.popupPadding,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftMedium,
    outline: "none",
    // In forced colours the shadow is gone: the system's line draws the edge.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  scrolls: {
    maxHeight: "22rem",
    overflowY: "auto",
    overscrollBehavior: "auto",
    scrollbarWidth: "none",
  },
  popupList: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    gap: grasp.space2,
    width: grasp.popupWidth,
    maxWidth: "100%",
    boxSizing: "border-box",
  },
  inPopup: {
    minHeight: 0,
    flexShrink: 1,
    overflowY: "auto",
    overscrollBehavior: "contain",
    scrollbarWidth: "none",
    marginInline: `calc(-1 * ${grasp.popupPadding})`,
    paddingInline: grasp.popupPadding,
    outline: "none",
  },
  // In a sheet the rows' fills hang out into the sheet's room, so a flag and a group's name start on
  // the edge the sheet's title and the search field share.
  inSheet: { outline: "none", marginInline: `calc(-1 * ${grasp.space3})` },
  choice: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    boxSizing: "border-box",
    // Every row as tall as one with two lines, so a row without a second name keeps the rhythm.
    minHeight: `max(${grasp.tap}, calc(${grasp.textSmLine} + ${grasp.textXsLine} + 2 * ${grasp.space1}))`,
    paddingInline: grasp.space3,
    paddingBlock: grasp.space1,
    borderRadius: `calc(${grasp.corner} - ${grasp.popupPadding})`,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
    WebkitTapHighlightColor: "transparent",
    backgroundColor: {
      default: "transparent",
      ":is([data-highlighted])": {
        default: grasp.itemFillHighlight,
        [FORCED]: "Highlight",
      },
    },
  },
  // A row the keys reach in a sheet stops below the search that stays at the top.
  clearOfSearch: {
    scrollMarginTop: `calc(${grasp.controlMd} + 2 * ${grasp.space2})`,
  },
  names: { display: "flex", flexDirection: "column", minWidth: 0, flexGrow: 1 },
  // As wide as its words and on the list's start edge (flex-start follows the list, not the name),
  // so a name that reads right to left still lines up with the names round it.
  ownName: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    whiteSpace: "nowrap",
  },
  secondName: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    whiteSpace: "nowrap",
  },
  tick: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.ink,
    marginInlineStart: "auto",
  },
  groupLabel: {
    display: "flex",
    alignItems: "center",
    minHeight: grasp.controlXs,
    paddingInline: grasp.space3,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: { default: grasp.muted, [FORCED]: "CanvasText" },
  },
  // Under a card the rows stand inside its padding: the help row starts there too, on their words.
  helpUnderCard: { marginInlineStart: grasp.popupPadding },
  helpRow: {
    display: "inline-flex",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: grasp.space2,
    paddingInline: grasp.space3,
    minHeight: { default: grasp.controlXs, [COARSE]: grasp.tap },
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: "transparent",
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    cursor: "pointer",
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
  // In a sheet the search stays at the top while the list scrolls under it, on the sheet's ground.
  stickySearch: {
    position: "sticky",
    top: `calc(-1 * ${grasp.space2})`,
    zIndex: 1,
    marginBlock: `calc(-1 * ${grasp.space2})`,
    paddingBlock: grasp.space2,
    backgroundColor: grasp.raised,
  },
  empty: {
    margin: 0,
    padding: grasp.space3,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },

  // ---- The pair: a segmented switch, the pill moving ----
  segmented: {
    position: "relative",
    isolation: "isolate",
    display: "inline-flex",
    padding: grasp.space1,
    gap: grasp.space1,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.quietFill,
    boxShadow: { default: "none", [FORCED]: "inset 0 0 0 1px CanvasText" },
  },
  segment: {
    position: "relative",
    zIndex: 1,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    margin: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerPill,
    backgroundColor: "transparent",
    color: {
      default: grasp.muted,
      ":is([data-checked])": grasp.ink,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    transitionProperty: "color",
    transitionDuration: simply.hover,
    // A 44px target on a touch screen.
    "::before": {
      content: "''",
      position: "absolute",
      insetBlock: { default: 0, [COARSE]: `calc((100% - ${grasp.tap}) / 2)` },
      insetInline: 0,
    },
  },
  segmentSm: {
    height: `calc(${grasp.controlXs} - 2 * ${grasp.space1})`,
    paddingInline: grasp.space2,
  },
  segmentMd: {
    height: `calc(${grasp.controlSm} - 2 * ${grasp.space1})`,
    paddingInline: grasp.space3,
  },
  pill: {
    position: "absolute",
    zIndex: 0,
    left: "var(--segmented-control-indicator-left)",
    top: "var(--segmented-control-indicator-top)",
    width: "var(--segmented-control-indicator-width)",
    height: "var(--segmented-control-indicator-height)",
    borderRadius: grasp.cornerPill,
    backgroundColor: { default: grasp.raised, [FORCED]: "Highlight" },
    boxShadow: grasp.liftLow,
    transitionProperty: "left, width",
    transitionDuration: simply.slide,
    transitionTimingFunction: grasp.ease,
  },
});
