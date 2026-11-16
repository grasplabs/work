// The look of a dialog, shared by its parts, and by its still drawing for the docs (still.tsx), so
// a drawing on a page wears the real panel's own styles, never a copy.
import * as stylex from "@stylexjs/stylex";

import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { panelMarker } from "./dialog.stylex";

const PHONE = media.belowPhone;

// Where a dialog stands while it opens and as it closes: a little lower and smaller, and clear.
// On a phone it is a sheet below the window instead.
const away = `translateY(${grasp.dialogFromShift}) scale(${grasp.dialogFromScale})`;
const below = "translateY(100%)";
// Arriving, it starts from the browser's own @starting-style, so the fade begins in the first frame
// it is drawn; UI SDK's data-starting-style comes off a frame later, which would hold the panel
// clear for that frame and the next. Leaving, UI SDK's data-ending-style.
const leaving = ":is([data-ending-style])";
const arriving = "@starting-style";

// The body's hairlines along its scroll: the bottom one at the top, both in between, the top one
// at the end. A hairline is 1px, as everywhere in the frame.
const lineBelow = `inset 0 -1px 0 ${grasp.line}`;
const lineAbove = `inset 0 1px 0 ${grasp.line}`;
const edges = stylex.keyframes({
  "0%": { boxShadow: lineBelow },
  "1%, 99%": { boxShadow: `${lineAbove}, ${lineBelow}` },
  "100%": { boxShadow: lineAbove },
});

export const dialogStyles = stylex.create({
  // The shade over the page. It follows the panel in and out.
  scrim: {
    position: "fixed",
    inset: 0,
    backgroundColor: grasp.dialogScrim,
    opacity: { default: 1, [arriving]: 0, [leaving]: 0 },
    transitionProperty: "opacity",
    transitionDuration: {
      default: simply.ui,
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
  },

  // The panel: raised, lifted, the one corner. Title, description, body and footer stand in one
  // column; only the body scrolls, so the title and the actions stay in view.
  panel: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    // The browser's own dialog box: no border, no padding, no limits of its own.
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    overflow: "hidden",
    color: grasp.text,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftHigh,
    borderRadius: {
      default: grasp.corner,
      [PHONE]: `${grasp.corner} ${grasp.corner} 0 0`,
    },
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    outline: "none",
  },

  // Over the page: in the middle of the window, clear of its edges by the gutter. On a phone, a
  // sheet along the bottom as wide as the window, over the keyboard when one is up.
  placed: {
    position: "fixed",
    insetInline: 0,
    insetBlockStart: { default: 0, [PHONE]: "auto" },
    insetBlockEnd: { default: 0, [PHONE]: "var(--keyboard-inset, 0px)" },
    marginBlock: { default: "auto", [PHONE]: 0 },
    marginInline: { default: "auto", [PHONE]: 0 },
    width: {
      default: `min(${grasp.dialogWidth}, 100% - 2 * ${grasp.dialogGutter})`,
      [PHONE]: "100%",
    },
    maxWidth: "none",
    height: "fit-content",
    maxHeight: {
      default: `calc(var(--visual-viewport-height, 100dvh) - 2 * ${grasp.dialogGutter})`,
      [PHONE]: `calc(var(--visual-viewport-height, 100dvh) - ${grasp.dialogGutter})`,
    },
  },

  // In and out: from a little lower and smaller, or from below the window on a phone. Leaving is
  // faster than arriving. With reduced motion it is there and gone at once.
  motion: {
    opacity: {
      default: 1,
      [arriving]: { default: 0, [PHONE]: 1 },
      [leaving]: { default: 0, [PHONE]: 1 },
    },
    transform: {
      default: "none",
      [arriving]: { default: away, [PHONE]: below },
      [leaving]: { default: away, [PHONE]: below },
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: simply.ui,
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
  },

  // The title, in the interface's own type a step up in weight, as Palermo sets it. It leaves room
  // at its end for the close button.
  title: {
    // Its own tracking: a host page's heading rules never reach it.
    letterSpacing: grasp.trackingUi,
    flexShrink: 0,
    margin: 0,
    paddingBlockStart: grasp.space6,
    paddingInlineStart: grasp.space6,
    paddingInlineEnd: `calc(${grasp.space6} + ${grasp.controlSm})`,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    overflowWrap: "anywhere",
    hyphens: "manual",
    textWrap: "balance",
  },
  description: {
    flexShrink: 0,
    margin: 0,
    marginBlockStart: grasp.space4,
    paddingInline: grasp.space6,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.muted,
    overflowWrap: "anywhere",
    hyphens: "manual",
    textWrap: "pretty",
  },

  // The body scrolls on its own. A hairline shows at its top once it has scrolled, and at its
  // bottom while there is more below, driven by its own scroll (no script). A body that does not
  // scroll has no timeline, so it draws no line. Room above and below for a field's focus ring,
  // which the scrolling box would otherwise cut.
  body: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    marginBlockStart: `calc(${grasp.space5} - ${grasp.space2})`,
    marginBlockEnd: `calc(-1 * ${grasp.space2})`,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space6,
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    color: grasp.text,
    overflowWrap: "anywhere",
    hyphens: "manual",
    // Only where the browser drives an animation by scroll; elsewhere no line at all. Never while
    // the panel leaves: a scroll-driven animation does not end, and the close waits for its
    // animations to end (Firefox would keep the panel and its shade over the page).
    animationName: {
      default: null,
      "@supports (animation-timeline: scroll())": {
        default: edges,
        [stylex.when.ancestor("[data-ending-style]", panelMarker)]: "none",
        [stylex.when.ancestor("[data-closed]", panelMarker)]: "none",
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
    // When it has more than it shows, it takes focus (body.tsx), so the keys can scroll it. Its
    // ring is focus.inside (src/focus), drawn inside it, where the panel does not cut it. Square
    // otherwise, so the hairlines run straight to its sides instead of bending up at its corners.
    borderRadius: { default: 0, ":focus-visible": grasp.cornerMark },
  },

  // The actions, at the end of the line, the main one last. On a phone they share the width, so
  // each is a wide target under the thumb. Clear of a phone's home bar.
  footer: {
    flexShrink: 0,
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: grasp.space2,
    marginBlockStart: grasp.space6,
    paddingInline: grasp.space6,
    paddingBlockEnd: {
      default: grasp.space6,
      [PHONE]: `max(${grasp.space6}, env(safe-area-inset-bottom))`,
    },
  },
  // On a phone the actions share the line in equal parts (they grow from nothing), each at least
  // as wide as its words on one line: a label longer than its share takes more, and when two do not
  // fit the footer wraps them onto two full lines before a label wraps in its button (eyes-a
  // A-layers-13: grown from their own widths, "Not yet" took 174px and "Send" 159px).
  action: {
    flexGrow: { default: 0, [PHONE]: 1 },
    flexBasis: { default: "auto", [PHONE]: 0 },
    minWidth: { default: null, [PHONE]: "fit-content" },
  },

  // The close button, level with the title's first line, its cross on the content's edge.
  close: {
    position: "absolute",
    insetBlockStart: `calc(${grasp.space6} + (${grasp.textMdLine} - ${grasp.controlSm}) / 2)`,
    insetInlineEnd: `calc(${grasp.space6} - ${grasp.space2})`,
    display: "flex",
  },

  // A body that holds fields: one under another.
  stack: {
    display: "grid",
    rowGap: grasp.space5,
  },
});
