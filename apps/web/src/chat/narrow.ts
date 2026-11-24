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

// A phone's window: the frame's narrow shell (under 40rem), where the chat
// docked covers the whole page, so a page about a subject shows itself
// first.
const phoneQuery = "(width < 40rem)";

const watchPhone = (changed: () => void): (() => void) => {
  const query = window.matchMedia(phoneQuery);
  query.addEventListener("change", changed);
  return () => {
    query.removeEventListener("change", changed);
  };
};

/** Whether the window is a phone's, where the chat docked covers the page. */
export const usePhone = (): boolean =>
  useSyncExternalStore(
    watchPhone,
    () => window.matchMedia(phoneQuery).matches,
    () => false
  );
