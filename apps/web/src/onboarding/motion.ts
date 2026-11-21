// How what makes up a step comes in: it fades, at times rising a little, on the library's one ease.
// Nothing slides further than that, and with reduced motion it is there at once. Shared by the
// frame and the steps, as the library's own `arrive` is (grasp/motion/arrive.ts).
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";

const fade = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const rise = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(0.25rem)" },
  to: { opacity: 1, transform: "none" },
});

export const motion = stylex.create({
  /** Fades in, as a step, the way back or the language turn up. */
  fade: {
    animationName: { default: fade, [media.reduced]: "none" },
    animationDuration: grasp.durationArrive,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
  },
  /** Fades in, rising a little: an answer, a word in the footer. */
  rise: {
    animationName: { default: rise, [media.reduced]: "none" },
    animationDuration: grasp.durationArrive,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
  },
  /** Waits a moment first, as the brain does for the step it belongs to. */
  late: { animationDelay: grasp.durationOpen },
  /** Changes in place (opacity, size), on the same ease. */
  change: {
    transitionProperty: "opacity, transform, width, height, max-width, filter",
    transitionDuration: grasp.durationArrive,
    transitionTimingFunction: grasp.ease,
  },
  /** Out of sight, a little low, until it is wanted: no slide with reduced motion. */
  waiting: {
    opacity: 0,
    transform: { default: "translateY(0.375rem)", [media.reduced]: "none" },
  },
  /** Out of sight, a little high, until it is wanted. */
  waitingAbove: {
    opacity: 0,
    transform: { default: "translateY(-0.5rem)", [media.reduced]: "none" },
  },
});

/**
 * The props of something that comes in `how` when `arrives`, and is there
 * at once when not, with what else styles it: marked `data-arrives` while it
 * comes in, so a test can tell.
 */
export const comeIn = (
  arrives: boolean,
  how: stylex.StyleXStyles,
  ...rest: stylex.StyleXStyles[]
) => ({
  ...stylex.props(...rest, arrives && how),
  "data-arrives": arrives ? "" : undefined,
});
