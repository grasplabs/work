// The look of a list in a popup, shared by the pickers: Combobox, Command, Context menu and
// Menubar. The surface is the popup tokens, as Select's; an item nests its corner inside the
// popup's. Every value is a token (src/tokens).
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { listMarker } from "./list.stylex";

const COARSE = media.coarse;
const FORCED = media.forced;
const REDUCED = media.reduced;

// While it opens and as it closes: a little smaller and clear.
const moving = ":is([data-starting-style], [data-ending-style])";

const SCROLLS = "@supports (animation-timeline: scroll())";

// The fade at the foot of a list that goes on: there while there is more below, gone at the end.
const more = stylex.keyframes({
  "0%, 94%": { opacity: 1 },
  "100%": { opacity: 0 },
});

// A row the list's foot cuts dims as it comes in, and only that row: a row in view whole is never
// greyed (second look A2-select-01). A filter, so an option out of use keeps its own opacity.
const cut = stylex.keyframes({
  "0%": { filter: "opacity(0.2)" },
  "100%": { filter: "opacity(1)" },
});

export const listStyles = stylex.create({
  // The popup: raised, lifted, the one corner, scrolling past popup-height or the room the window
  // has. It grows from where it was opened and shrinks back, faster.
  popup: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    boxSizing: "border-box",
    maxWidth: `min(${grasp.popupWidth}, var(--available-width, ${grasp.popupWidth}))`,
    maxHeight: `min(${grasp.popupHeight}, var(--available-height, ${grasp.popupHeight}))`,
    overflowY: "auto",
    overscrollBehavior: "contain",
    margin: 0,
    padding: grasp.popupPadding,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.popupLift,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    outline: "none",
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [moving]: 0 },
    transform: {
      default: "none",
      [moving]: {
        default: `scale(${grasp.popupFromScale})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: simply.popup,
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
  },

  // A row while the list's foot cuts it: dimmed by how much of it is hidden, clear once whole.
  cut: {
    animationName: {
      default: null,
      [SCROLLS]: {
        default: cut,
        [stylex.when.ancestor("[data-ending-style]", listMarker)]: "none",
        [stylex.when.ancestor("[data-closed]", listMarker)]: "none",
      },
    },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "none" },
    animationTimeline: { default: null, [SCROLLS]: "view(block 0px)" },
    animationRange: { default: null, [SCROLLS]: "entry 0% entry 100%" },
  },

  // A list that goes on says so: a fade at its foot, over the last rows, while there is more below
  // (the list's own scroll drives it; a list that fits draws none). Placed after the list, it takes
  // no room. Never while the popup leaves: a scroll-driven animation does not end, and the close
  // waits for its animations to end.
  more: {
    display: "block",
    position: "sticky",
    insetBlockEnd: `calc(-1 * ${grasp.popupPadding})`,
    // Over the end padding only, so it never lies on a row in view whole; a row the foot cuts dims
    // itself (cut). The padding's band was 32px over the rows and greyed a whole last option
    // (second look A2-select-01).
    height: grasp.popupPadding,
    marginBlockStart: `calc(-1 * ${grasp.popupPadding})`,
    marginInline: `calc(-1 * ${grasp.popupPadding})`,
    // No end margin: one pulled the popup's end padding under the last row, so a list that fits
    // overflowed by that padding and its fade lay on the last live row (A2-select-01).
    backgroundImage: {
      default: `linear-gradient(to bottom, transparent, ${grasp.popupFill})`,
      [FORCED]: "none",
    },
    opacity: 0,
    pointerEvents: "none",
    animationName: {
      default: null,
      [SCROLLS]: {
        default: more,
        [stylex.when.ancestor("[data-ending-style]", listMarker)]: "none",
        [stylex.when.ancestor("[data-closed]", listMarker)]: "none",
      },
    },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "both" },
    animationTimeline: { default: null, [SCROLLS]: "scroll(nearest)" },
  },

  // An item: an icon, its words, and something at the end (a tick, a key). Palermo's measure: 32px
  // tall, 8px in from each side, words in text-xs medium, in ink as Select's options are: a group's
  // name over it is muted and a weight lighter, and an item out of use fainter still, so a name, a
  // choice and a choice out of use read as three things (eyes-a A-choice-02, A-layers-05). 44px on
  // touch.
  item: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minHeight: { default: grasp.controlSm, [COARSE]: grasp.tap },
    boxSizing: "border-box",
    paddingBlock: `calc((${grasp.controlSm} - ${grasp.textXsLine}) / 2)`,
    paddingInline: grasp.space2,
    borderRadius: `min(calc(${grasp.corner} - ${grasp.popupPadding}), calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
    fontSize: { default: grasp.textXs, [COARSE]: grasp.textSm },
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
    overflowWrap: "anywhere",
    hyphens: "manual",
    textDecoration: "none",
  },
  // A menu's item, after Palermo's menus: the interface's text size in ink, 36px with our line.
  menuItem: {
    minHeight: { default: grasp.controlMd, [COARSE]: grasp.tap },
    paddingBlock: `calc((${grasp.controlMd} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(calc(${grasp.corner} - ${grasp.popupPadding}), calc(${grasp.controlMd} / 2))`,
    color: grasp.ink,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
  },
  // A menu is as wide as its longest item, and at least 60% of popup-width.
  menuPopup: {
    minWidth: `calc(${grasp.popupWidth} * 0.6)`,
    width: "max-content",
  },
  // Where the keyboard or the pointer is. In forced colours, the system's own highlight.
  itemHighlighted: {
    backgroundColor: {
      default: grasp.itemFillHighlight,
      [FORCED]: "Highlight",
    },
    color: { default: grasp.ink, [FORCED]: "HighlightText" },
  },
  // Out of use: the quiet colour at half strength, no highlight. Ink at half strength came out the
  // grey of a group's name, so an item out of use read as one more name (eyes-a A-layers-05); this
  // stands clearly under the name, and far under a live item.
  itemDisabled: {
    opacity: grasp.dim,
    color: { default: grasp.muted, [FORCED]: "GrayText" },
    cursor: "not-allowed",
  },
  // A danger item says so in the danger colour.
  itemDanger: {
    color: { default: grasp.danger, [FORCED]: "CanvasText" },
  },
  // The icon takes the words' colour.
  itemIcon: {
    display: "inline-flex",
    flexShrink: 0,
    color: "inherit",
  },
  itemIconDanger: {
    color: grasp.danger,
  },
  itemWords: {
    flexGrow: 1,
    minWidth: 0,
  },
  // The end of an item: a tick or a key, quiet.
  itemEnd: {
    display: "inline-flex",
    flexShrink: 0,
    marginInlineStart: "auto",
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  tick: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.ink,
  },
  // The letters the typed words matched: in ink, never a fill.
  mark: {
    backgroundColor: "transparent",
    color: { default: grasp.ink, [FORCED]: "inherit" },
    fontWeight: "inherit",
  },
  // A group's name: small and quiet, above its items, in the muted colour and a weight under theirs
  // (regular to their medium), as Dropdown menu's label is.
  groupLabel: {
    paddingInline: grasp.space2,
    paddingTop: grasp.space2,
    paddingBottom: grasp.space1,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
    color: { default: grasp.muted, [FORCED]: "CanvasText" },
    userSelect: "none",
  },
  separator: {
    height: 1,
    marginBlock: grasp.space1,
    // Edge to edge of the popup, as Palermo's.
    marginInline: `calc(-1 * ${grasp.popupPadding})`,
    backgroundColor: { default: grasp.line, [FORCED]: "CanvasText" },
  },
  // Nothing matches: one quiet line, as tall as an item.
  empty: {
    // UI SDK keeps the part in the page while something matches; it takes room only when empty.
    display: { default: "none", ":is([data-empty])": "block" },
    boxSizing: "border-box",
    minHeight: grasp.controlSm,
    paddingBlock: `calc((${grasp.controlSm} - ${grasp.textXsLine}) / 2)`,
    paddingInline: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    textAlign: "start",
  },
});
