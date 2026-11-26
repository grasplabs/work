import { isThemeId, isThemeMode } from "@grasp-os/ui/components/theme-toggle";
import type { ThemeId, ThemeMode } from "@grasp-os/ui/components/theme-toggle";

// Light, dark or the system's (Damsko's modes): a UI preference, the
// person's own, kept in this browser's storage, one entry per person, so
// someone else signing in here keeps theirs. public/theme.js applies it,
// as Damsko's themes.css reads it (the root's `data-mode`), and as the
// scheme resolves (the `dark` class), which an App page's frame and the
// canvas drawings follow: `grasp-theme` is the choice applied last, which
// it reads before first paint.

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

// The theme's colours (Damsko's themes: Evergreen, Pine, Paper), chosen in
// Settings › Appearance, kept beside the mode in the same way: one entry
// per person, and `grasp-theme-id`, the one applied last, which theme.js
// puts on the root as `data-theme` before first paint.

/** The colours theme.js applies. */
const appliedIdKey = "grasp-theme-id";

const personIdKey = (userId: string): string => `grasp-theme-id:${userId}`;

/** The colours `userId` chose in this browser; Evergreen until they choose. */
export const readThemeId = (userId: string): ThemeId => {
  try {
    const kept = localStorage.getItem(personIdKey(userId));
    return isThemeId(kept) ? kept : "evergreen";
  } catch {
    return "evergreen";
  }
};

/** Has theme.js apply the colours `id` now, and on the next load before first paint. */
export const applyThemeId = (id: ThemeId): void => {
  try {
    localStorage.setItem(appliedIdKey, id);
  } catch {
    // Storage blocked: theme.js shows Evergreen.
  }
  document.dispatchEvent(new Event("grasp-theme"));
};

/** Keeps `id` as `userId`'s colours in this browser, and applies them. */
export const chooseThemeId = (userId: string, id: ThemeId): void => {
  try {
    localStorage.setItem(personIdKey(userId), id);
  } catch {
    // Storage blocked: theme.js shows Evergreen whatever is chosen.
  }
  applyThemeId(id);
};
