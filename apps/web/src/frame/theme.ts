import { isThemeMode } from "@grasp-os/ui/components/theme-toggle";
import type { ThemeMode } from "@grasp-os/ui/components/theme-toggle";

// Light, dark or the system's (Damsko's modes): a UI preference, the
// person's own, kept in this browser's storage, one entry per person, so
// someone else signing in here keeps theirs. public/theme.js applies it,
// as Damsko's themes.css reads it (the root's `data-mode`) and the kit's
// theme does (its `dark` class): `grasp-theme` is the choice applied last,
// which it reads before first paint.

/** The choice theme.js applies. */
const appliedKey = "grasp-theme";

const personKey = (userId: string): string => `grasp-theme:${userId}`;

/** The theme `userId` chose in this browser; the system's until they choose. */
export const readTheme = (userId: string): ThemeMode => {
  try {
    const kept = localStorage.getItem(personKey(userId));
    return isThemeMode(kept) ? kept : "system";
  } catch {
    return "system";
  }
};

/**
 * Calls `onChange` when a choice may have changed: made here (the
 * `grasp-theme` event chooseTheme sends) or in another tab (`storage`).
 * Returns how to stop.
 */
export const onThemeChange = (onChange: () => void): (() => void) => {
  document.addEventListener("grasp-theme", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    document.removeEventListener("grasp-theme", onChange);
    window.removeEventListener("storage", onChange);
  };
};

/** Has theme.js apply `theme` now, and on the next load before first paint. */
export const applyTheme = (theme: ThemeMode): void => {
  try {
    localStorage.setItem(appliedKey, theme);
  } catch {
    // Storage blocked: theme.js follows the system.
  }
  document.dispatchEvent(new Event("grasp-theme"));
};

/** Keeps `theme` as `userId`'s choice in this browser, and applies it. */
export const chooseTheme = (userId: string, theme: ThemeMode): void => {
  try {
    localStorage.setItem(personKey(userId), theme);
  } catch {
    // Storage blocked: theme.js follows the system whatever is chosen.
  }
  applyTheme(theme);
};
