// The look of a toast and its stack (toaster.tsx). UI SDK's ToastRegion measures the toasts and
// sets the numbers a stack needs (--toast-index, --toast-offset, --toast-height and the region's
// --toast-front-height and --toast-stack-height); these styles place the toasts by them.
import * as stylex from "@stylexjs/stylex";

import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

const REDUCED = media.reduced;
// Where a toast is pulled to: the swipe, plus the way out once it leaves (set by `leaving` below).
const swipeX = "calc(var(--toast-swipe-x, 0px) + var(--toast-exit-x, 0px))";
const swipeY = "calc(var(--toast-swipe-y, 0px) + var(--toast-exit-y, 0px))";
const expanded = ":is([data-expanded])";
const enteringFront = ":is([data-starting-style][data-front])";
// It fades as it comes in, front or behind, and as it goes.
const fading = ":is([data-starting-style], [data-ending-style])";
// A toast that leaves without a swipe: its time ran out, its action ran, or Escape.
const leavingPlain = ":is([data-ending-style]:not([data-swipe-direction]))";
// While the stack is closed, only the front toast shows its words; the ones behind are quiet cards.
const behind = ":not([data-front], [data-expanded])";

// An icon arriving in place: the result of a promise taking the spinner's place.
const arrive = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.8)" },
  to: { opacity: 1, transform: "none" },
});
const arriveStill = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

export const toastStyles = stylex.create({
  // The region: a fixed column at an edge of the window, as tall as the newest toast while the
  // stack is closed, and as tall as all of them while it is open. Clear of the edges by the gutter.
  region: {
    position: "fixed",
    boxSizing: "border-box",
    width: `min(${grasp.toastWidth}, 100vw - 2 * ${grasp.dialogGutter})`,
    height: {
      default: "var(--toast-front-height)",
      [expanded]: `calc(var(--toast-stack-height) + (var(--toast-count) - 1) * ${grasp.toastGap})`,
    },
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    overflow: "visible",
    listStyle: "none",
    inset: "auto",
    transitionProperty: "height",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // Clear of a phone's home bar and notch too.
  bottom: {
    bottom: `calc(${grasp.dialogGutter} + var(--keyboard-inset, 0px) + env(safe-area-inset-bottom, 0px))`,
  },
  top: { top: `calc(${grasp.dialogGutter} + env(safe-area-inset-top, 0px))` },
  start: { insetInlineStart: grasp.dialogGutter },
  end: { insetInlineEnd: grasp.dialogGutter },
  // UI SDK centres it with its own `translate: -50% 0`; a transform here would move it twice.
  center: { left: "50%" },

  // A toast: raised, the popup's lift, the one corner. Its icon beside its words, the action under them.
  toast: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "absolute",
    insetInline: 0,
    // The newest in front: the further back in the stack, the lower.
    zIndex: "calc(-1 * var(--toast-index))",
    boxSizing: "border-box",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: grasp.space3,
    alignItems: "start",
    height: {
      default: "var(--toast-height)",
      ":not([data-front], [data-expanded])": "var(--toast-front-height)",
    },
    overflow: "hidden",
    margin: 0,
    padding: grasp.space4,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftMedium,
    color: grasp.text,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdLine,
    userSelect: "none",
    // Its icon and words read this: 0 behind the front toast while the stack is closed.
    "--toast-content": { default: 1, [behind]: 0 },
    opacity: { default: 1, [fading]: 0 },
    transitionProperty: {
      default: "translate, scale, opacity, height",
      [REDUCED]: "opacity",
    },
    // With reduced motion it is simply there, and simply gone.
    transitionDuration: {
      default: simply.appear,
      ":is([data-starting-style], [data-swiping])": "0s",
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
  },
  // The way out. A swiped toast carries on in the direction of the swipe, a whole toast further;
  // any other goes back a short way towards its edge. Both while they fade.
  leavingBottom: {
    "--toast-exit-x": {
      default: "0px",
      ":is([data-ending-style][data-swipe-direction=right])": {
        default: "100%",
        [REDUCED]: "0px",
      },
      ":is([data-ending-style][data-swipe-direction=left])": {
        default: "-100%",
        [REDUCED]: "0px",
      },
    },
    "--toast-exit-y": {
      default: "0px",
      ":is([data-ending-style][data-swipe-direction=down])": {
        default: "100%",
        [REDUCED]: "0px",
      },
      ":is([data-ending-style][data-swipe-direction=up])": {
        default: "-100%",
        [REDUCED]: "0px",
      },
      [leavingPlain]: { default: "50%", [REDUCED]: "0px" },
    },
  },
  leavingTop: {
    "--toast-exit-x": {
      default: "0px",
      ":is([data-ending-style][data-swipe-direction=right])": {
        default: "100%",
        [REDUCED]: "0px",
      },
      ":is([data-ending-style][data-swipe-direction=left])": {
        default: "-100%",
        [REDUCED]: "0px",
      },
    },
    "--toast-exit-y": {
      default: "0px",
      ":is([data-ending-style][data-swipe-direction=down])": {
        default: "100%",
        [REDUCED]: "0px",
      },
      ":is([data-ending-style][data-swipe-direction=up])": {
        default: "-100%",
        [REDUCED]: "0px",
      },
      [leavingPlain]: { default: "-50%", [REDUCED]: "0px" },
    },
  },
  // What the toast holds: hidden behind the front while the stack is closed, so one thing is read.
  content: {
    opacity: "var(--toast-content)",
    transitionProperty: "opacity",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  arrive: {
    display: "inline-flex",
    animationName: { default: arrive, [REDUCED]: arriveStill },
    animationDuration: grasp.durationSwap,
    animationTimingFunction: grasp.ease,
  },
  noIcon: {
    gridTemplateColumns: "minmax(0, 1fr)",
  },
  // A toast that stays: a third column for its close button, in the top end corner.
  closable: { gridTemplateColumns: "auto minmax(0, 1fr) auto" },
  closableNoIcon: { gridTemplateColumns: "minmax(0, 1fr) auto" },
  // Level with the title's line, and as far into the corner as its own room allows, so the cross
  // stands as far from the edges as the icon does at the start.
  close: {
    display: "flex",
    marginBlock: `calc((${grasp.textMdLine} - ${grasp.controlXs}) / 2)`,
    marginInlineEnd: `calc(-1 * ${grasp.space2})`,
  },
  // Along the bottom: the newest at the foot, the older ones peeking above it, or stacked above
  // it while the stack is open. It rises a little as it fades in.
  atBottom: {
    bottom: 0,
    transformOrigin: "bottom center",
    translate: {
      default: `${swipeX} calc(var(--toast-index) * -1 * ${grasp.toastPeek} + ${swipeY})`,
      [expanded]: `${swipeX} calc(-1 * (var(--toast-offset) + var(--toast-index) * ${grasp.toastGap}) + ${swipeY})`,
      // It rises a short way, not a whole toast: from its first frame its action stands within
      // space-3 of where it comes to rest, so a press aimed there lands on it (the product's note:
      // a press while it slid in from below missed).
      [enteringFront]: `${swipeX} ${grasp.space3}`,
    },
    scale: {
      default: `calc(1 - var(--toast-index) * ${grasp.toastPeekScale})`,
      [expanded]: 1,
    },
  },
  // Along the top, the same turned over.
  atTop: {
    top: 0,
    transformOrigin: "top center",
    translate: {
      default: `${swipeX} calc(var(--toast-index) * ${grasp.toastPeek} + ${swipeY})`,
      [expanded]: `${swipeX} calc(var(--toast-offset) + var(--toast-index) * ${grasp.toastGap} + ${swipeY})`,
      [enteringFront]: `${swipeX} calc(-1 * ${grasp.space3})`,
    },
    scale: {
      default: `calc(1 - var(--toast-index) * ${grasp.toastPeekScale})`,
      [expanded]: 1,
    },
  },

  icon: {
    display: "inline-flex",
    alignItems: "center",
    height: grasp.textMdLine,
  },
  default: { color: grasp.muted },
  info: { color: grasp.info },
  success: { color: grasp.success },
  warning: { color: grasp.attention },
  error: { color: grasp.danger },
  loading: { color: grasp.muted },

  words: {
    display: "grid",
    rowGap: grasp.space1,
    minWidth: 0,
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  title: {
    margin: 0,
    lineHeight: grasp.textMdLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  description: {
    margin: 0,
    color: grasp.muted,
  },
  // The action at the bottom end, at its own width, a cancel to its start: the same on a phone.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: grasp.space2,
    marginBlockStart: grasp.space2,
  },
});
