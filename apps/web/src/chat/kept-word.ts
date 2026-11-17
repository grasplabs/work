import { useSyncExternalStore } from "react";

// A person's own UI preference, kept in this browser's storage as one
// word, one entry per person, as the theme is (frame/theme.ts), so someone
// else signing in here keeps theirs. Shown wherever it is drawn as soon as
// it is chosen, here or in another tab. The chat's background
// (backdrop-look.ts) and its box (composer-look.ts) are kept this way.

/** One kind of kept word: `name` keys it, `first` stands until a person chooses. */
export const keptWord = (name: string, first: string) => {
  const keyOf = (userId: string): string => `${name}:${userId}`;
  const read = (userId: string): string => {
    try {
      return localStorage.getItem(keyOf(userId)) ?? first;
    } catch {
      return first;
    }
  };
  const onChange = (changed: () => void): (() => void) => {
    document.addEventListener(name, changed);
    window.addEventListener("storage", changed);
    return () => {
      document.removeEventListener(name, changed);
      window.removeEventListener("storage", changed);
    };
  };
  return {
    /** Keeps `word` as `userId`'s choice, and shows it wherever it is drawn. */
    keep: (userId: string, word: string): void => {
      try {
        localStorage.setItem(keyOf(userId), word);
      } catch {
        // Storage blocked: the first stays.
      }
      document.dispatchEvent(new Event(name));
    },
    /** The word `userId` chose, following a change made anywhere; `first` without one. */
    useWord: (userId: string | undefined): string =>
      useSyncExternalStore(onChange, () =>
        userId === undefined ? first : read(userId)
      ),
  };
};
