// The look of a popover, shared by its parts, and by its still drawing for the docs (still.tsx), so
// a drawing on a page wears the real panel's own styles, never a copy.
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { popoverMarker } from "./popover.stylex";

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
// The ring, as src/focus/focus.ts draws it (focus.ring), here so the panel can draw it for its body too.
const RING_LINE = `${grasp.ringWidth} solid ${grasp.ring}`;
const RING_FORCED = `calc(2 * ${grasp.ringWidth}) solid Highlight`;

// Where a popover stands while it opens and as it closes: a little smaller and clear. It grows
// from `--transform-origin`, the point on the trigger UI SDK placed it against, so it comes from
// whichever side it landed on, in either reading direction.
const moving = ":is([data-starting-style], [data-ending-style])";

// The body's ends fade while there is more past them: the bottom one at the top, both in between,
// the top one at the end, so a line cut on the panel's edge reads as more to come. The panel's own
// edge is round, so a fade, not a hairline that would bend with its corners. Where there is more,
// the fade runs on through the body's padding as a faint tail, to nothing at the edge: a line cut
// on the panel's edge is never a crisp slice (A2-popover-01), yet a line that starts in the padding
// still shows faintly, so a cut in a gap between paragraphs still says there is more (A3-layers-02;
// an empty inset hid the next note whenever it began there). At an end with nothing past it the
// padding shows as it is.
const FADE = grasp.space6;
const INSET = grasp.popoverPadding;
const TAIL = "rgb(0 0 0 / 30%)";
const fadeBelow = `linear-gradient(to bottom, black calc(100% - ${INSET} - ${FADE}), ${TAIL} calc(100% - ${INSET}), transparent)`;
const fadeBoth = `linear-gradient(to bottom, transparent, ${TAIL} ${INSET}, black calc(${INSET} + ${FADE}), black calc(100% - ${INSET} - ${FADE}), ${TAIL} calc(100% - ${INSET}), transparent)`;
const fadeAbove = `linear-gradient(to bottom, transparent, ${TAIL} ${INSET}, black calc(${INSET} + ${FADE}))`;
const ends = stylex.keyframes({
  "0%": { maskImage: fadeBelow },
  "1%, 99%": { maskImage: fadeBoth },
  "100%": { maskImage: fadeAbove },
});

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
    // Scrolled by the keys, what comes into view keeps the same inset from the end as the words at rest.
    scrollPaddingBlock: surface.padding,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    borderRadius: "inherit",
    cornerShape: "inherit",
    // Only where the browser drives an animation by scroll, and never while the panel leaves: a
    // scroll-driven animation does not end, and the close may wait for its animations to end.
    animationName: {
      default: null,
      "@supports (animation-timeline: scroll())": {
        default: ends,
        [stylex.when.ancestor(
          ":is([data-ending-style], [data-closed])",
          popoverMarker
        )]: "none",
      },
    },
    animationDuration: {
      default: null,
      "@supports (animation-timeline: scroll())": "auto",
    },
    animationTimingFunction: {
      default: null,
      "@supports (animation-timeline: scroll())": "linear",
    },
    animationFillMode: {
      default: null,
      "@supports (animation-timeline: scroll())": "both",
    },
    animationTimeline: {
      default: null,
      "@supports (animation-timeline: scroll())": "scroll(self)",
    },
  },

  // The panel's ring: on the panel when it holds focus itself, and when the body does (a body that
  // scrolls takes focus, panel.tsx). Drawn on the body, inside its edge, the body's own end fades
  // faded the ring away with the words, leaving two loose lines down the sides (A3-layers-01); on
  // the panel it stands whole round the rounded edge, off it as every ring does.
  ring: {
    outline: {
      default: "none",
      ":focus-visible": { default: RING_LINE, [media.forced]: RING_FORCED },
      ':has(> [data-slot="popover-body"]:focus-visible)': {
        default: RING_LINE,
        [media.forced]: RING_FORCED,
      },
    },
    outlineOffset: {
      default: grasp.ringOffset,
      [media.forced]: grasp.ringOffsetMark,
    },
  },
  // The body draws no ring of its own: the panel draws it (ring, above).
  bodyRing: {
    outline: "none",
  },

  // In and out from the trigger's side. Leaving is faster than arriving. With reduced motion it is
  // there and gone at once.
  motion: {
    opacity: { default: 1, [moving]: 0 },
    transform: { default: "none", [moving]: `scale(${grasp.popupFromScale})` },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: simply.popup,
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
