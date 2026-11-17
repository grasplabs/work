import { useSyncExternalStore } from "react";

import {
  backdropKinds,
  defaultLook,
  ditherPatterns,
  ditherTones,
} from "../grasp/backdrop/index.ts";
import type { BackdropLook } from "../grasp/backdrop/index.ts";

// What stands behind Chat's start: the person's look (Grasp UI's
// BackdropLook: a backdrop and, for a dither, its pattern and colour). A
// UI preference, the person's own, kept in this browser's storage, one
// entry per person, as the theme is (frame/theme.ts), so someone else
// signing in here keeps theirs. Kept as one word, `backdrop:pattern:tone`.
// Chosen in Settings, Appearance (settings/backdrop-settings.tsx).

const personKey = (userId: string): string => `grasp-backdrop:${userId}`;

/** What says a look was chosen in this tab. */
const chosen = "grasp-backdrop";

/** A look as one word, as it is kept. */
const wordOf = ({ backdrop, pattern, tone }: BackdropLook): string =>
  `${backdrop}:${pattern}:${tone}`;

const firstWord = wordOf(defaultLook);

/** The look a kept word names; the first where it names none (a backdrop since removed, say). */
const lookOf = (word: string): BackdropLook => {
  const [backdrop, pattern, tone] = word.split(":");
  const found = {
    backdrop: backdropKinds.find((each) => each === backdrop),
    pattern: ditherPatterns.find((each) => each === pattern),
    tone: ditherTones.find((each) => each === tone),
  };
  return found.backdrop === undefined ||
    found.pattern === undefined ||
    found.tone === undefined
    ? defaultLook
    : { backdrop: found.backdrop, pattern: found.pattern, tone: found.tone };
};

/** The word kept for `userId` in this browser; the first until they choose, or where storage is blocked. */
const readWord = (userId: string): string => {
  try {
    return localStorage.getItem(personKey(userId)) ?? firstWord;
  } catch {
    return firstWord;
  }
};

/** Calls `onChange` when a look may have changed: here, or in another tab. Returns how to stop. */
const onLookChange = (onChange: () => void): (() => void) => {
  document.addEventListener(chosen, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    document.removeEventListener(chosen, onChange);
    window.removeEventListener("storage", onChange);
  };
};

/** Keeps `look` as `userId`'s choice in this browser, and shows it wherever it is drawn. */
export const chooseLook = (userId: string, look: BackdropLook): void => {
  try {
    localStorage.setItem(personKey(userId), wordOf(look));
  } catch {
    // Storage blocked: the first look stays.
  }
  document.dispatchEvent(new Event(chosen));
};

/** The look `userId` chose in this browser, following a change made anywhere. */
export const useLook = (userId: string): BackdropLook =>
  lookOf(useSyncExternalStore(onLookChange, () => readWord(userId)));
