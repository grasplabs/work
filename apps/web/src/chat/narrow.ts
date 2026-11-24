import { useSyncExternalStore } from "react";

// Whether the window is a phone's: too narrow for the chat beside the
// page, at the width the frame folds its sidebar away (768px).

const narrowQuery = "(max-width: 767px)";

const watchWidth = (changed: () => void): (() => void) => {
  const query = window.matchMedia(narrowQuery);
  query.addEventListener("change", changed);
  return () => {
    query.removeEventListener("change", changed);
  };
};

/** Whether the window is too narrow for the chat beside the page. */
export const useNarrow = (): boolean =>
  useSyncExternalStore(
    watchWidth,
    () => window.matchMedia(narrowQuery).matches,
    () => false
  );
