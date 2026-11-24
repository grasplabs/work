import { useSyncExternalStore } from "react";

// Whether the window is narrower than a phone's: Damsko's own breakpoint
// (media.maxSm), for what the onboarding's frame draws differently there
// (an arrow alone for the ways back and on) and no style can say.

const belowPhone = "(width < 40rem)";

const onWidth = (changed: () => void): (() => void) => {
  const query = matchMedia(belowPhone);
  query.addEventListener("change", changed);
  return () => {
    query.removeEventListener("change", changed);
  };
};

/** Whether the window is narrower than a phone's. */
export const useNarrow = (): boolean =>
  useSyncExternalStore(
    onWidth,
    () => matchMedia(belowPhone).matches,
    () => false
  );
