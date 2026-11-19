import { useSyncExternalStore } from "react";

// Whether the window is narrower than a phone's: the library's own
// breakpoint (media.belowPhone), for what a table shows differently there
// and can't say with a column's `hideBelow` alone.

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
