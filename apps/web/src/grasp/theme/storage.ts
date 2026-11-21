// A small helper that keeps a person's mode and theme in localStorage, for a product that has no
// place of its own for them. It reads storage after the first render (never during it), so a page
// rendered on a server and in the browser starts the same; until then both values are undefined
// and the provider leaves the page as the pre-paint script set it. A change in another tab arrives
// through the storage event.
"use client";

import { useEffect, useState } from "react";

import { themeStorageKey } from "./script";
import { isThemeId, isThemeMode } from "./themes";
import type { ThemeId, ThemeMode } from "./themes";

export interface StoredTheme {
  mode: ThemeMode | undefined;
  theme: ThemeId | undefined;
}

export interface UseStoredThemeOptions {
  /**
   * Where the choice is kept: the same key the pre-paint script reads.
   * @default "grasp-theme"
   */
  storageKey?: string;
  /**
   * The mode before a person has chosen one.
   * @default "system"
   */
  defaultMode?: ThemeMode;
  /**
   * The theme before a person has chosen one.
   * @default "evergreen"
   */
  defaultTheme?: ThemeId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads the kept choice; storage that cannot be read (a private window) gives the defaults. */
const read = (
  key: string,
  fallbackMode: ThemeMode,
  fallbackTheme: ThemeId
): StoredTheme => {
  let kept: unknown = null;
  try {
    kept = JSON.parse(window.localStorage.getItem(key) ?? "null");
  } catch {
    kept = null;
  }
  const record = isRecord(kept) ? kept : {};
  return {
    mode: isThemeMode(record.mode) ? record.mode : fallbackMode,
    theme: isThemeId(record.theme) ? record.theme : fallbackTheme,
  };
};

/** Keeps the choice; storage that cannot be written leaves it for this page only. */
const write = (key: string, value: StoredTheme) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nowhere to keep it: the page still shows the choice until it is closed.
  }
};

export const useStoredTheme = (options?: UseStoredThemeOptions) => {
  const key = options?.storageKey ?? themeStorageKey;
  const fallbackMode = options?.defaultMode ?? "system";
  const fallbackTheme = options?.defaultTheme ?? "evergreen";
  const [stored, setStored] = useState<StoredTheme>({
    mode: undefined,
    theme: undefined,
  });

  useEffect(() => {
    // Read once the page is on screen, never during a render; the pre-paint script has already
    // drawn it in the kept choice, so nothing changes on screen when this lands.
    queueMicrotask(() => {
      setStored(read(key, fallbackMode, fallbackTheme));
    });
    const changed = (event: StorageEvent) => {
      if (event.key === key) {
        setStored(read(key, fallbackMode, fallbackTheme));
      }
    };
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener("storage", changed);
    };
  }, [key, fallbackMode, fallbackTheme]);

  const setMode = (mode: ThemeMode) => {
    const next = { mode, theme: stored.theme ?? fallbackTheme };
    write(key, next);
    setStored(next);
  };
  const setTheme = (theme: ThemeId) => {
    const next = { mode: stored.mode ?? fallbackMode, theme };
    write(key, next);
    setStored(next);
  };
  return { mode: stored.mode, theme: stored.theme, setMode, setTheme };
};
