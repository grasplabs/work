import { duration, media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// How a question of the new agent's setup comes in, as the last one goes:
// it fades in over duration-mark on the one ease, in its exact place, so
// nothing moves. With reduced motion it is there at once.

const fade = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

export const arrive = stylex.create({
  in: {
    animationName: { default: fade, [media.reducedMotion]: "none" },
    animationDuration: duration.mark,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
  },
});
