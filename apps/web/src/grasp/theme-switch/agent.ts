// The Theme switch on the page's agent bridge (UI SDK's createAgent). Its value is the mode, one of
// its three items; `setValue` chooses a mode and `setTheme` a theme, each by its name or id. A name
// that is not one of them is refused with the real ones. (Not `closed`: that would check the
// theme's name against the modes too.) An agent's change is drawn in one frame: the reveal is for a
// person's own pick.
import { definePrimitive } from "@ui-sdk/core";

import { isThemeId, isThemeMode } from "../theme";
import type { ThemeId, ThemeMode } from "../theme";
import { themeSwitchNotices } from "./words";

interface ThemeSwitchAgentOptions {
  value?: ThemeMode;
  theme?: ThemeId;
  items?: { value: string; label: string }[];
  themes?: { value: string; label: string }[];
  onValueChange?: (mode: ThemeMode) => void;
  onThemeChange?: (theme: ThemeId) => void;
}

const asMode = (
  wanted: string,
  items: { value: string; label: string }[] | undefined
) =>
  items?.find(
    (item) =>
      item.value === wanted || item.label.toLowerCase() === wanted.toLowerCase()
  )?.value;

export const themeSwitchAgent = definePrimitive({
  name: "theme-switch",
  options: {
    value: "string",
    theme: "string",
    items: "value",
    themes: "value",
    onValueChange: "callback",
    onThemeChange: "callback",
  },
  state: (options: ThemeSwitchAgentOptions) => ({
    value: options.value,
    theme: options.theme,
    items: options.items ?? [],
  }),
  api: (context) => {
    context.onOptions((options) => {
      context.store.set({
        value: options.value,
        theme: options.theme,
        items: options.items ?? [],
      });
    });
    return {
      /** Chooses a mode: Light, Dark or System. */
      setValue: (mode: string) => {
        const { items, onValueChange } = context.options();
        const value = asMode(mode, items);
        if (!isThemeMode(value)) {
          throw new Error(
            themeSwitchNotices.noMode(
              mode,
              (items ?? []).map((item) => item.label)
            )
          );
        }
        onValueChange?.(value);
      },
      /** Chooses a theme, by its name or id. */
      setTheme: (theme: string) => {
        const { themes, onThemeChange } = context.options();
        const value = asMode(theme, themes);
        if (!isThemeId(value)) {
          throw new Error(
            themeSwitchNotices.noTheme(
              theme,
              (themes ?? []).map((item) => item.label)
            )
          );
        }
        onThemeChange?.(value);
      },
    };
  },
  slots: (slot) => ({
    root: slot({}),
  }),
  agent: { actions: ["setValue", "setTheme"] },
});
