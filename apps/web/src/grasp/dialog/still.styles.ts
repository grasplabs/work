// The still drawing of a dialog, for the docs only (still.tsx): the frame that stands in for the
// window, and the frozen moments of its motion. Kept apart from styles.ts, so a product that
// imports the dialog never ships them.
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

// The same places as the real motion's (styles.ts): a little lower and smaller, or below.
const away = `translateY(${grasp.dialogFromShift}) scale(${grasp.dialogFromScale})`;
const below = "translateY(100%)";

// The still drawings stand frozen a third of the way through their time, on the real curve and
// the real durations: a CSS animation, paused, so no script is needed.
const openIn = stylex.keyframes({
  from: { opacity: 0, transform: away },
  to: { opacity: 1, transform: "none" },
});
const sheetIn = stylex.keyframes({
  from: { transform: below },
  to: { transform: "none" },
});
const shadeIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});
// Leaving is its own way out, not the way in played back, so the curve eases as the real one does.
const openOut = stylex.keyframes({
  from: { opacity: 1, transform: "none" },
  to: { opacity: 0, transform: away },
});
const sheetOut = stylex.keyframes({
  from: { transform: "none" },
  to: { transform: below },
});
const shadeOut = stylex.keyframes({
  from: { opacity: 1 },
  to: { opacity: 0 },
});

export const stillStyles = stylex.create({
  // A piece of page the size of its box, with the dialog in it as the window would hold it.
  // A picture, not a control: inert, and no pointer over its buttons or hover on them, so nothing
  // in it reads as pressable (Ruben pressed a still's buttons, 15 November).
  frame: {
    pointerEvents: "none",
    position: "relative",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-start",
    width: "100%",
    minWidth: 0,
    height: "100%",
    padding: grasp.space4,
    overflow: "hidden",
    color: grasp.text,
    // A soft ground, as Popover's still frame: no hard outline.
    backgroundColor: grasp.soft,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
  // In the frame, not over the window: the frame stands in for the window.
  scrim: {
    position: "absolute",
  },
  // The middle of the frame, whatever the window's width: a still is the sheet only when asked.
  placed: {
    position: "absolute",
    insetBlockStart: 0,
    insetBlockEnd: 0,
    marginBlock: "auto",
    marginInline: "auto",
    width: `min(${grasp.dialogWidth}, 100% - 2 * ${grasp.dialogGutter})`,
    maxHeight: `calc(100% - 2 * ${grasp.dialogGutter})`,
    borderRadius: grasp.corner,
  },
  footer: {
    paddingBlockEnd: grasp.space6,
  },
  action: {
    flexGrow: 0,
  },
  // The phone's sheet in a frame of any width.
  sheet: {
    insetBlockStart: "auto",
    insetBlockEnd: 0,
    marginBlock: 0,
    marginInline: 0,
    width: "100%",
    maxHeight: `calc(100% - ${grasp.dialogGutter})`,
    borderRadius: `${grasp.corner} ${grasp.corner} 0 0`,
  },
  sheetAction: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: "fit-content",
  },
  // Frozen a third of the way in, or a third of the way out.
  frozen: {
    animationTimingFunction: grasp.ease,
    animationPlayState: "paused",
    animationFillMode: "both",
  },
  openingPanel: {
    animationName: openIn,
    animationDuration: grasp.durationUi,
    animationDelay: `calc(-1 * ${grasp.durationUi} / 3)`,
  },
  closingPanel: {
    animationName: openOut,
    animationDuration: grasp.durationLeave,
    animationDelay: `calc(-1 * ${grasp.durationLeave} / 3)`,
  },
  sheetOpening: {
    animationName: sheetIn,
  },
  sheetClosing: {
    animationName: sheetOut,
  },
  openingShade: {
    animationName: shadeIn,
    animationDuration: grasp.durationUi,
    animationDelay: `calc(-1 * ${grasp.durationUi} / 3)`,
  },
  closingShade: {
    animationName: shadeOut,
    animationDuration: grasp.durationLeave,
    animationDelay: `calc(-1 * ${grasp.durationLeave} / 3)`,
  },
});
