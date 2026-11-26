import { useSyncExternalStore } from "react";

/** Whether the tab is shown now, followed as it changes; never on the server. */
export const useTabShown = (): boolean =>
  useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      return () => {
        document.removeEventListener("visibilitychange", onChange);
      };
    },
    () => document.visibilityState === "visible",
    () => false
  );
