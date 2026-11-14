// Simply there: the times things move or fade in Grasp UI, which become 0s when the person asks
// for reduced motion. A part that would move, grow or fade is then simply there, and simply gone.
// One place for it, so every part gets it the same way:
//
//   transitionProperty: "opacity, transform",
//   transitionDuration: { default: simply.ui, ":is([data-ending-style])": simply.leave },
//
// Use these for movement, size and fades. A colour easing under the pointer is not motion: keep
// grasp.durationHover there. Where one transition list holds both, write both:
//   transitionDuration: `${simply.press}, ${grasp.durationHover}`
//
// A spinner or a progress bar that must keep a sign of life under reduced motion does not use
// these; it keeps a slow fade of opacity alone (src/components/spinner).
import * as stylex from "@stylexjs/stylex";

import { grasp } from "../tokens/tokens.stylex";

const REDUCED = "@media (prefers-reduced-motion: reduce)";

export const simply = stylex.defineVars({
  /** A press shrinking a control a little: duration-press, 0s with reduced motion. */
  press: { default: grasp.durationPress, [REDUCED]: "0s" },
  /** A small change of place or shape (a chevron turning): duration-hover, 0s with reduced motion. */
  hover: { default: grasp.durationHover, [REDUCED]: "0s" },
  /** A mark drawn in, words sliding in beside it: duration-mark, 0s with reduced motion. */
  mark: { default: grasp.durationMark, [REDUCED]: "0s" },
  /** One state giving way to the next on a control: duration-swap, 0s with reduced motion. */
  swap: { default: grasp.durationSwap, [REDUCED]: "0s" },
  /** A toast coming into its stack: duration-open, 0s with reduced motion. */
  appear: { default: grasp.durationOpen, [REDUCED]: "0s" },
  /** Something opening (a popup, a panel): duration-ui, 0s with reduced motion. */
  ui: { default: grasp.durationUi, [REDUCED]: "0s" },
  /** Something leaving, faster than it came: duration-leave, 0s with reduced motion. */
  leave: { default: grasp.durationLeave, [REDUCED]: "0s" },
  /** A tooltip leaving: tooltip-leave, 0s with reduced motion. */
  tooltipLeave: { default: grasp.tooltipLeave, [REDUCED]: "0s" },
  /** Words following their mark: result-follow, 0s with reduced motion. */
  follow: { default: grasp.resultFollow, [REDUCED]: "0s" },
  /** The Composer's light coming on: composer-light-in, 0s with reduced motion. */
  lightIn: { default: grasp.composerLightIn, [REDUCED]: "0s" },
  /** An approval request settling into its new form: approval-settle, 0s with reduced motion. */
  settle: { default: grasp.approvalSettle, [REDUCED]: "0s" },
  /** Approve's light leaning in under a pointer: duration-lean, 0s with reduced motion. */
  lean: { default: grasp.durationLean, [REDUCED]: "0s" },
  /** A collapsible opening to its height: collapsible-open, 0s with reduced motion. */
  open: { default: grasp.collapsibleOpen, [REDUCED]: "0s" },
  /** The active bar sliding to its tab: active-bar-move, 0s with reduced motion. */
  slide: { default: grasp.activeBarMove, [REDUCED]: "0s" },
  /** A switch's thumb travelling on its spring: switch-travel, 0s with reduced motion. */
  travel: { default: grasp.switchTravel, [REDUCED]: "0s" },
  /** A switch's light following its thumb: switch-trail, 0s with reduced motion. */
  trail: { default: grasp.switchTrail, [REDUCED]: "0s" },
});
