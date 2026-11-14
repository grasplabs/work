// The still drawing of a popover, for the docs only (still.tsx): the frame that stands in for the
// window, and the frozen moments of its motion. Kept apart from styles.ts, so a product that
// imports the popover never ships them.
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

// The same tokens as the real panel's (styles.ts), written here again: StyleX reads a style's
// values from this file and the token files only.
const width = grasp.popoverWidth;
const gutter = grasp.popupGutter;
const away = `scale(${grasp.popupFromScale})`;

// The still drawings stand frozen a third of the way through their time, on the real curve and
// the real durations: a CSS animation, paused, so no script is needed. Drawn below the trigger,
// as a popover opens by default, so it grows from the trigger's side: from above.
const openIn = stylex.keyframes({
  from: { opacity: 0, transform: away },
  to: { opacity: 1, transform: "none" },
});
// Leaving is its own way out, not the way in played back, so the curve eases as the real one does.
const openOut = stylex.keyframes({
  from: { opacity: 1, transform: "none" },
  to: { opacity: 0, transform: away },
});

export const stillStyles = stylex.create({
  // A piece of page with the trigger near its top and the popover under it, as the window would
  // hold them: clear of the edges by the gutter, the gap between them as in a product.
  frame: {
    position: "relative",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    rowGap: grasp.popoverGap,
    width: "100%",
    minWidth: 0,
    minHeight: grasp.stageMinPhone,
    padding: gutter,
    overflow: "hidden",
    color: grasp.text,
    // A soft ground, so the white panel stands on it as it does on a page: no hard outline.
    backgroundColor: grasp.soft,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
  // In the frame, as wide as it would be in the window: the frame's padding is the gutter.
  panel: {
    flexShrink: 0,
    width: `min(${width}, 100%)`,
    transformOrigin: "top center",
  },
  // A phone: the trigger at the start of its line, the popover the frame's width less the gutter.
  phoneFrame: {
    alignItems: "stretch",
  },
  phoneTrigger: {
    alignSelf: "flex-start",
  },
  phonePanel: {
    width: "auto",
  },
  // Frozen a third of the way in, or a third of the way out.
  frozen: {
    animationTimingFunction: grasp.ease,
    animationPlayState: "paused",
    animationFillMode: "both",
  },
  opening: {
    animationName: openIn,
    animationDuration: grasp.durationUi,
    animationDelay: `calc(-1 * ${grasp.durationUi} / 3)`,
  },
  closing: {
    animationName: openOut,
    animationDuration: grasp.durationLeave,
    animationDelay: `calc(-1 * ${grasp.durationLeave} / 3)`,
  },
});
