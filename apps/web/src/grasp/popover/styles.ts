// The look of a popover, shared by its parts, and by its still drawing for the docs (still.tsx), so
// a drawing on a page wears the real panel's own styles, never a copy.
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const PHONE = media.belowPhone;

// The popover's surface and room: the popup tokens it shares with Select, and its own padding.
// The gap to the trigger (popover-gap) and the gutter also reach UI SDK as numbers (panel.tsx).
const surface = {
  fill: grasp.popupFill,
  lift: grasp.popupLift,
  padding: grasp.popoverPadding,
  width: grasp.popoverWidth,
  height: grasp.popupHeight,
  gutter: grasp.popupGutter,
};

// The gap between the panel's rows: the title, the fields, the footer. The description stands
// closer under its title.
const ROW = grasp.space4;

// Where a popover stands while it opens and as it closes: a little smaller and clear. It grows
// from `--transform-origin`, the point on the trigger UI SDK placed it against, so it comes from
// whichever side it landed on, in either reading direction.
const moving = ":is([data-starting-style], [data-ending-style])";

export const popoverStyles = stylex.create({
  // The panel: raised, lifted, the one corner. It holds the body (below), which scrolls only when
  // the window has less room than it needs.
  panel: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    // The browser's own popover box: no border, no padding, no limits of its own.
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: grasp.text,
    backgroundColor: surface.fill,
    boxShadow: surface.lift,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    overflowWrap: "anywhere",
    hyphens: "manual",
  },

  // Beside its trigger, never wider than the window less the gutter on each side. Under 640px it
  // takes that whole width, still beside its trigger. No taller than popup-height, and less when
  // the window has less room beside the trigger.
  placed: {
    width: {
      default: `min(${surface.width}, 100vw - 2 * ${surface.gutter})`,
      [PHONE]: `calc(100vw - 2 * ${surface.gutter})`,
    },
    maxWidth: "none",
    height: "fit-content",
    maxHeight: `min(${surface.height}, var(--available-height, ${surface.height}))`,
    overflow: "hidden",
    transformOrigin: "var(--transform-origin)",
  },

  // The rows, one column: the title, the fields, the footer. The one part that scrolls; when it
  // holds more than it shows it takes focus (panel.tsx), so the keys can scroll it.
  body: {
    boxSizing: "border-box",
    display: "grid",
    alignContent: "start",
    rowGap: ROW,
    minHeight: 0,
    padding: surface.padding,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    borderRadius: "inherit",
    cornerShape: "inherit",
  },

  // In and out from the trigger's side. Leaving is faster than arriving. With reduced motion it is
  // there and gone at once.
  motion: {
    opacity: { default: 1, [moving]: 0 },
    transform: { default: "none", [moving]: `scale(${grasp.popupFromScale})` },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: simply.ui,
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
  },

  // The title names the popover: the interface's own type, a step up from its text.
  title: {
    // Its own tracking: a host page's heading rules never reach it.
    letterSpacing: grasp.trackingUi,
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    textWrap: "balance",
  },
  // Close under its title, not a whole row away.
  description: {
    margin: 0,
    marginBlockStart: `calc(${grasp.space2} - ${ROW})`,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    textWrap: "pretty",
  },

  // The actions, at the end of the line, the main one last.
  footer: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: grasp.space2,
  },
});
