import { useSyncExternalStore } from "react";

/** Whether the person asked for less motion, as their system says now: the brain's dots then stand still and change in place. */

const lessMotion = "(prefers-reduced-motion: reduce)";

const prefersLessMotion = () => window.matchMedia(lessMotion).matches;

const onMotionChange = (listener: () => void) => {
  const media = window.matchMedia(lessMotion);
  media.addEventListener("change", listener);
  return () => {
    media.removeEventListener("change", listener);
  };
};

export const useLessMotion = (): boolean =>
  useSyncExternalStore(onMotionChange, prefersLessMotion, () => false);
