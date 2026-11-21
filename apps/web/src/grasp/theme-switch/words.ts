// The Theme switch's words, in English. The product gives them in its languages through GraspWords
// (src/words), as the catalogue's `themeSwitch`; a caller's `label`, `themesLabel`, `modeWords` and
// `iconLabel` still win until the breaking release's step 5. A theme's own name and line come from
// its definition (src/theme), as a name, not from here.
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

/** The switch's words in the catalogue: its names, the three modes', and the icon button's. */
export const themeSwitchWords = {
  /** Its name. */
  label: "Theme",
  /** The name of the group of themes, under the modes. */
  themes: "Colours",
  ...defaultModeWords,
  icon: defaultIconLabel,
};

export type ThemeSwitchCatalogueWords = typeof themeSwitchWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    themeSwitch: ThemeSwitchCatalogueWords;
  }
}

/** What it tells an agent that asked for a mode or a theme it does not have: the agent reads English, so these are kept here and not in the catalogue. */
export const themeSwitchNotices = {
  noMode: (mode: string, modes: string[]) =>
    `No mode "${mode}" in Theme. Its modes: ${modes.join(", ")}.`,
  noTheme: (theme: string, known: string[]) =>
    `No theme "${theme}" in Theme. Its themes: ${known.join(", ")}.`,
};
