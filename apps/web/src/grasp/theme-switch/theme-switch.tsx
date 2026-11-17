// ThemeSwitch: how a person chooses light, dark or the system's, and Grasp's own themes. One part in
// three forms, all reading the nearest ThemeProvider (src/theme):
//
//   segmented  Light, Dark, System, with icons; the pill moves (the default, for a header or a menu)
//   icon       one button that cycles them, 28 or 32px, for a dense toolbar
//   picker     tiles that are real miniatures of the interface, modes and themes, for settings:
//              hovering a theme shows it on the page; leaving puts the chosen one back
//
//   <ThemeProvider mode={mode} theme={theme} onModeChange={setMode} onThemeChange={setTheme}>
//     <ThemeSwitch />
//   </ThemeProvider>
//
// A person's own pick is revealed from the switch they pressed (the provider's `change`); an
// agent's pick, through the page's agent bridge, is drawn in one frame. Every visible word is a
// prop with an English default. Every value is a token (src/tokens). A caller may set layout only.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { usePart, usePrimitive } from "@ui-sdk/react/primitive";

import type { LayoutStyle } from "../layout/layout";
import { useTheme } from "../theme";
import type { ThemeId, ThemeMode } from "../theme";
import { themeSwitchAgent } from "./agent";
import { ThemeSwitchIcon } from "./icon";
import { ThemeSwitchPicker } from "./picker";
import { ThemeSwitchSegmented } from "./segmented";
import { switchStyles as styles } from "./styles";
import { defaultIconLabel, defaultModeWords, defaultThemeWords } from "./words";
import type { ModeWords, ThemeWords } from "./words";

/** What a caller may style: where the switch sits. Never its look. */
export type ThemeSwitchLayoutStyle = LayoutStyle;

/** Every prop a ThemeSwitch takes. */
export interface ThemeSwitchProps {
  /**
   * `segmented` for a header or a menu; `icon` where there is no room; `picker` on a settings page.
   * @default "segmented"
   */
  variant?: "segmented" | "icon" | "picker";
  /** @deprecated Use `variant`. */
  form?: "segmented" | "icon" | "picker";
  /**
   * Its name, said with the choice ("Theme, Dark, 2 of 3"), and the picker's mode heading.
   * @default "Theme"
   */
  label?: string;
  /**
   * The picker's heading over the themes.
   * @default "Colours"
   */
  themesLabel?: string;
  /**
   * The picker shows Grasp's themes under the modes.
   * @default true
   */
  showThemes?: boolean;
  /**
   * The icon button's size: 28 or 32px.
   * @default "md"
   */
  size?: "sm" | "md";
  /** Each mode's name and the line under its tile, in the page's language. */
  modeWords?: Partial<Record<ThemeMode, ModeWords>>;
  /** Each theme's name and the line under its tile, in the page's language. */
  themeWords?: Partial<Record<ThemeId, ThemeWords>>;
  /**
   * The icon button's name, from its label, the mode it shows and the one a press goes to.
   * @default (label, current, next) => `${label}, ${current}. Switch to ${next}`
   */
  iconLabel?: (label: string, current: string, next: string) => string;
  /** @deprecated Use `layout`. */
  style?: ThemeSwitchLayoutStyle;
  /** Layout only: where it sits. */
  layout?: ThemeSwitchLayoutStyle;
}

export const ThemeSwitch = ({
  form: formDeprecated,
  variant: form = formDeprecated ?? "segmented",
  label = "Theme",
  themesLabel = "Colours",
  showThemes = true,
  size = "md",
  modeWords,
  themeWords,
  iconLabel,
  style: styleProp,
  layout,
}: ThemeSwitchProps) => {
  const controls = useTheme();
  const wordsOfMode = (mode: ThemeMode): ModeWords =>
    modeWords?.[mode] ?? defaultModeWords[mode];
  const wordsOfTheme = (theme: ThemeId): ThemeWords =>
    themeWords?.[theme] ?? defaultThemeWords(theme);
  const shownMode = controls.mode ?? "system";

  // On the page's agent bridge: the mode is its value, one of three; an agent's change is instant.
  const agent = usePrimitive(themeSwitchAgent, {
    value: controls.mode,
    theme: controls.theme,
    items: (["light", "dark", "system"] as const).map((mode) => ({
      value: mode,
      label: wordsOfMode(mode).name,
    })),
    themes: (["evergreen", "pine", "paper"] as const).map((theme) => ({
      value: theme,
      label: wordsOfTheme(theme).name,
    })),
    onValueChange: (mode: ThemeMode) => {
      controls.chooseMode(mode, undefined, "instant");
    },
    onThemeChange: (theme: ThemeId) => {
      controls.chooseTheme(theme, undefined, "instant");
    },
  });

  const name = (current: ThemeMode, next: ThemeMode): string =>
    (iconLabel ?? defaultIconLabel)(
      label,
      wordsOfMode(current).name,
      wordsOfMode(next).name
    );
  const chooseMode = (mode: ThemeMode, origin?: { x: number; y: number }) => {
    controls.chooseMode(mode, origin);
  };
  const chooseTheme = (theme: ThemeId, origin?: { x: number; y: number }) => {
    controls.chooseTheme(theme, origin);
  };
  const preview = (theme?: ThemeId) => {
    controls.showPreview(theme);
  };

  const body = () => {
    if (form === "icon") {
      return (
        <ThemeSwitchIcon
          mode={shownMode}
          size={size}
          name={name}
          onChoose={chooseMode}
        />
      );
    }
    if (form === "picker") {
      return (
        <ThemeSwitchPicker
          mode={controls.mode}
          theme={controls.theme}
          modeLabel={label}
          themeLabel={themesLabel}
          showThemes={showThemes}
          modeWords={wordsOfMode}
          themeWords={wordsOfTheme}
          onChooseMode={chooseMode}
          onChooseTheme={chooseTheme}
          onPreview={preview}
        />
      );
    }
    return (
      <ThemeSwitchSegmented
        mode={controls.mode}
        label={label}
        words={wordsOfMode}
        onChoose={chooseMode}
      />
    );
  };

  return usePart(
    agent,
    "root",
    {},
    {
      "aria-label": label,
      ...stylex.props(
        styles.root,
        form !== "picker" && styles.rootInline,
        layout ?? styleProp
      ),
      children: body(),
    }
  );
};
