import { useSyncExternalStore } from "react";

// Whether the window is wide (Tailwind's lg): from there, side panels sit
// beside the page; narrower, they open in a sheet over it.

const wideQuery = "(min-width: 64rem)";

const onWide = (onChange: () => void): (() => void) => {
  const query = matchMedia(wideQuery);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
};

const isWide = (): boolean => matchMedia(wideQuery).matches;

/** Whether the window is wide now, followed as it changes. */
export const useWide = (): boolean => useSyncExternalStore(onWide, isWide);
