// The Theme switch's words: every visible word is a prop, with these English defaults, so a
// product can translate all of it.
import { themes } from "../theme";
import type { ThemeId, ThemeMode } from "../theme";

/** What a mode is called, and the line under its tile. */
export interface ModeWords {
  name: string;
  line: string;
}

/** What a theme is called, and the line under its tile. */
export interface ThemeWords {
  name: string;
  line: string;
}

export const defaultModeWords: Record<ThemeMode, ModeWords> = {
  light: { name: "Light", line: "Always light" },
  dark: { name: "Dark", line: "Always dark" },
  system: { name: "System", line: "As your device" },
};

/** A theme's own name and line, from its definition. */
export const defaultThemeWords = (id: ThemeId): ThemeWords => {
  const theme = themes.find((each) => each.id === id);
  return { name: theme?.name ?? id, line: theme?.tagline ?? "" };
};

/** The icon button's name: where it is, and where a press takes it. */
export const defaultIconLabel = (
  label: string,
  current: string,
  next: string
) => `${label}, ${current}. Switch to ${next}`;
