// The still drawing of a tooltip, for the docs only (still.tsx): the frame that stands in for the
// page around its trigger, and the frozen moments of its motion. Kept apart from styles.ts, so a
// product that imports the tooltip never ships them.
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

// The same tokens as the real panel's (styles.ts), written here again: StyleX reads a style's
// values from this file and the token files only.
const away = `scale(${grasp.popupFromScale})`;
const below = `0 ${grasp.tooltipRise}`;

// Frozen a third of the way through their time, on the real curve and the real durations: a CSS
// animation, paused, so no script is needed. Drawn above the trigger, as a tooltip opens by
// default, so it grows from the trigger's side: from below.
const openIn = stylex.keyframes({
  from: { opacity: 0, transform: away, translate: below },
  to: { opacity: 1, transform: "none", translate: "none" },
});
// Leaving is its own way out, not the way in played back, so the curve eases as the real one does.
const openOut = stylex.keyframes({
  from: { opacity: 1, transform: "none", translate: "none" },
  to: { opacity: 0, transform: away, translate: below },
});

export const stillStyles = stylex.create({
  // A piece of page with the tooltip above its trigger, the gap between them as in a product. It
  // keeps the tooltip's room when it is closed, so every cell of the row is the same height.
  frame: {
    display: "grid",
    justifyItems: "center",
    alignContent: "end",
    rowGap: grasp.tooltipGap,
    minWidth: 0,
    minHeight: `calc(${grasp.textXsLine} + ${grasp.space3} + ${grasp.tooltipGap} + ${grasp.controlMd})`,
  },
  // Above its trigger, though it follows it in the page, as UI SDK places it by default.
  panel: {
    order: -1,
    maxWidth: `min(${grasp.tooltipWidth}, 100%)`,
    transformOrigin: "bottom center",
  },
  // Frozen a third of the way in, or a third of the way out.
  frozen: {
    animationTimingFunction: grasp.ease,
    animationPlayState: "paused",
    animationFillMode: "both",
  },
  opening: {
    animationName: openIn,
    animationDuration: grasp.durationHover,
    animationDelay: `calc(-1 * ${grasp.durationHover} / 3)`,
  },
  closing: {
    animationName: openOut,
    animationDuration: grasp.tooltipLeave,
    animationDelay: `calc(-1 * ${grasp.tooltipLeave} / 3)`,
  },
});
