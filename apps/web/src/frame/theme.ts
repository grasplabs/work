import { isThemeId } from "../grasp/theme/index.ts";
import type { ThemeId } from "../grasp/theme/index.ts";

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

// The theme's colours (Grasp UI's themes: Evergreen, Pine, Paper), kept
// beside the mode in the same way: one entry per person, and
// `grasp-theme-id`, the one applied last, which theme.js puts on <html> as
// `data-grasp-theme` before first paint. Not under Grasp UI's own
// `grasp-theme` key, which holds the mode here.

/** The colours theme.js applies. */
const appliedIdKey = "grasp-theme-id";

const personIdKey = (userId: string): string => `grasp-theme-id:${userId}`;

/** Until someone chooses: Grasp as it is. */
export const defaultThemeId: ThemeId = "evergreen";

/** The colours `userId` chose in this browser; Evergreen until they choose. */
export const readThemeId = (userId: string): ThemeId => {
  try {
    const kept = localStorage.getItem(personIdKey(userId));
    return isThemeId(kept) ? kept : defaultThemeId;
  } catch {
    return defaultThemeId;
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

/** Keeps the colours `id` as `userId`'s choice in this browser, and applies them. */
export const chooseThemeId = (userId: string, id: ThemeId): void => {
  try {
    localStorage.setItem(personIdKey(userId), id);
  } catch {
    // Storage blocked: theme.js shows Evergreen whatever is chosen.
  }
  applyThemeId(id);
};
