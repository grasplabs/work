// Light, dark or the system's: a UI preference, the person's own, kept in
// this browser's storage, one entry per person, so someone else signing in
// here keeps theirs. public/theme.js applies it: `grasp-theme` is the choice
// applied last, which it reads before first paint.

export const themes = ["light", "dark", "system"] as const;

export type Theme = (typeof themes)[number];

/** The choice theme.js applies. */
const appliedKey = "grasp-theme";

const personKey = (userId: string): string => `grasp-theme:${userId}`;

export const isTheme = (value: unknown): value is Theme =>
  themes.some((theme) => theme === value);

/** The theme `userId` chose in this browser; the system's until they choose. */
export const readTheme = (userId: string): Theme => {
  try {
    const kept = localStorage.getItem(personKey(userId));
    return isTheme(kept) ? kept : "system";
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
export const applyTheme = (theme: Theme): void => {
  try {
    localStorage.setItem(appliedKey, theme);
  } catch {
    // Storage blocked: theme.js follows the system.
  }
  document.dispatchEvent(new Event("grasp-theme"));
};

/** Keeps `theme` as `userId`'s choice in this browser, and applies it. */
export const chooseTheme = (userId: string, theme: Theme): void => {
  try {
    localStorage.setItem(personKey(userId), theme);
  } catch {
    // Storage blocked: theme.js follows the system whatever is chosen.
  }
  applyTheme(theme);
};
