import { useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { ThemeProvider } from "../grasp/theme/index.ts";
import {
  applyTheme,
  applyThemeId,
  chooseTheme,
  chooseThemeId,
  onThemeChange,
  readTheme,
  readThemeId,
} from "./theme.ts";

// The person's mode and colours, kept by frame/theme.ts, handed to Grasp
// UI's ThemeProvider: the Theme switch (Settings › Appearance) and the
// Sidebar's Appearance read and change the same choice, here and in
// another tab. The change is one frame: the kit's parts follow the `dark`
// class theme.js sets as the choice is kept, which a View Transition's
// picture would not wait for.

/** The person's mode and colours, as kept now. */
export const usePersonTheme = (userId: string) => {
  // Read where it is kept, so a choice made in another tab shows here too.
  const mode = useSyncExternalStore(onThemeChange, () => readTheme(userId));
  const theme = useSyncExternalStore(onThemeChange, () => readThemeId(userId));
  return { mode, theme };
};

/** Grasp UI's ThemeProvider, on the person's choice. */
export const PersonTheme = ({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) => {
  const { mode, theme } = usePersonTheme(userId);
  // What theme.js painted first was whoever was here last; this is theirs.
  useEffect(() => {
    applyTheme(readTheme(userId));
    applyThemeId(readThemeId(userId));
  }, [userId]);
  return (
    <ThemeProvider
      change="instant"
      mode={mode}
      onModeChange={(next) => {
        chooseTheme(userId, next);
      }}
      onThemeChange={(next) => {
        chooseThemeId(userId, next);
      }}
      theme={theme}
    >
      {children}
    </ThemeProvider>
  );
};
