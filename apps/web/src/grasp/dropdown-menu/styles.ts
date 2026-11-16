// The look of a dropdown menu, shared by its parts, and by the menus that will be built from them
// (Context menu, Menubar). Palermo's measure: a 4px padded panel at high lift, items with 8px round
// their icon and words (36px tall on our 20px line, 34px on Palermo's 18px), labels, and separators
// that run to the panel's edge. Our colours, corner and type. Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { menuMarker } from "./menu.stylex";

const COARSE = media.coarse;
const FORCED = media.forced;
const REDUCED = media.reduced;

// Where a menu stands while it opens and as it closes: a little smaller and clear. It grows from
// `--transform-origin`, the point on the trigger UI SDK placed it against.
const moving = ":is([data-starting-style], [data-ending-style])";

// An item's corner nests inside the panel's, capped at half a control's height.
const ITEM_CORNER = `min(calc(${grasp.corner} - ${grasp.popupPadding}), calc(${grasp.controlMd} / 2))`;

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

export const menuStyles = stylex.create({
  // The panel: raised, at high lift, the one corner. At least menu-width, as wide as its longest
  // item up to popup-width, never wider than the window less the gutter. It scrolls past
  // popup-height, or the room the window has.
  panel: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    boxSizing: "border-box",
    minWidth: `min(${grasp.menuWidth}, 100vw - 2 * ${grasp.popupGutter})`,
    maxWidth: `min(${grasp.popupWidth}, 100vw - 2 * ${grasp.popupGutter})`,
    maxHeight: `min(${grasp.popupHeight}, var(--available-height, ${grasp.popupHeight}))`,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    margin: 0,
    padding: grasp.popupPadding,
    // The browser's own popover box: no border, no limits of its own. Forced colours drop the fill
    // and the lift, so a 1px border in the text colour draws its edge.
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.menuLift,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    outline: "none",
    transformOrigin: "var(--transform-origin)",
  },

  // In and out from the trigger's side: duration-ui in, the faster duration-leave out. Under
  // reduced motion it is simply there, and simply gone.
  motion: {
    opacity: { default: 1, [moving]: 0 },
    transform: {
      default: "none",
      [moving]: {
        default: `scale(${grasp.popupFromScale})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: { default: "opacity, transform", [REDUCED]: "opacity" },
    transitionDuration: {
      default: simply.popup,
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
  },

  // An item: an icon, its words, and something at the end (keys, a tick, the work). Palermo's
  // weight and room; 44px tall on a touch screen.
  item: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: { default: null, [COARSE]: grasp.tap },
    boxSizing: "border-box",
    padding: grasp.menuItemPadding,
    borderRadius: ITEM_CORNER,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
    overflowWrap: "anywhere",
    hyphens: "manual",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
  },
  // Where the keyboard or the pointer is: the highlight is the focus mark. In forced colours, the
  // system's own highlight.
  highlighted: {
    backgroundColor: {
      default: grasp.itemFillHighlight,
      [FORCED]: "Highlight",
    },
    color: { default: grasp.ink, [FORCED]: "HighlightText" },
  },
  // Out of use: half strength, still reached by the keys, as the menu pattern asks.
  disabled: {
    opacity: grasp.dim,
    color: { default: grasp.ink, [FORCED]: "GrayText" },
    cursor: "not-allowed",
  },
  // An item that deletes or cannot be undone: its words and icon in the danger colour.
  danger: {
    color: { default: grasp.danger, [FORCED]: "CanvasText" },
  },
  dangerHighlighted: {
    color: { default: grasp.danger, [FORCED]: "HighlightText" },
  },
  // Working: the pointer says so.
  pending: {
    cursor: "progress",
  },

  // The icon takes the words' colour.
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    color: "inherit",
  },
  words: {
    flexGrow: 1,
    minWidth: 0,
  },
  // The words of an item with no icon, in a panel where other items have one: they start where
  // the others' words do, past an empty icon slot, so the column of words stays one edge.
  wordsBare: {
    paddingInlineStart: {
      default: 0,
      [stylex.when.ancestor(":has([data-menu-icon])", menuMarker)]:
        `calc(${grasp.iconSm} + ${grasp.space2})`,
    },
  },
  // The end of an item: the keys of its shortcut, quieter and smaller than its words.
  end: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    marginInlineStart: "auto",
    color: { default: grasp.muted, [FORCED]: "inherit" },
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
    whiteSpace: "nowrap",
  },
  // The words of a failed action, in the danger colour.
  failed: {
    color: { default: grasp.danger, [FORCED]: "inherit" },
  },
  spinner: {
    animationName: { default: spin, [REDUCED]: "none" },
    animationDuration: grasp.durationSpin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  // The tick of a checked item, in the words' colour.
  tick: {
    display: "inline-flex",
    flexShrink: 0,
    marginInlineStart: "auto",
    color: "inherit",
  },

  // The chosen one of a radio group: a dot in the tick's place, so one of many reads apart from
  // the tick of an option that is on or off. As wide as an icon, so the words keep their room.
  dot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: grasp.iconSm,
    height: grasp.iconSm,
    marginInlineStart: "auto",
    "::before": {
      content: '""',
      width: `calc(${grasp.iconSm} * 0.375)`,
      height: `calc(${grasp.iconSm} * 0.375)`,
      borderRadius: grasp.cornerCircle,
      backgroundColor: { default: "currentColor", [FORCED]: "CanvasText" },
    },
  },

  // A group's name: small and quiet, above its items, as tall as a small control.
  label: {
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    minHeight: grasp.controlSm,
    paddingInline: grasp.menuItemPadding,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
    color: { default: grasp.muted, [FORCED]: "CanvasText" },
    userSelect: "none",
  },
  // A hairline between groups, edge to edge of the panel, as Palermo's.
  separator: {
    height: grasp.hairline,
    marginBlock: grasp.popupPadding,
    marginInline: `calc(-1 * ${grasp.popupPadding})`,
    backgroundColor: { default: grasp.line, [FORCED]: "CanvasText" },
  },
});
