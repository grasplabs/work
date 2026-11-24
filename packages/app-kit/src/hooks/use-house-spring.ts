import { useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";

/**
 * A soft spring, over within 300 ms, for what is picked up and put down:
 * it settles with the faintest give. Instant under reduced motion.
 */
export const useHouseSpring = (): Transition =>
  useReducedMotion() === true
    ? { duration: 0 }
    : { type: "spring", duration: 0.3, bounce: 0.15 };
