import { useMatch } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

// How the chat box draws Grasp at work, the person's own, as the
// reference's (#2503's chat/composer-look.ts): the colour of its working
// light and success halo (the accent) and how the light's edge is drawn
// (the edge). Chosen in Settings › Appearance (settings/composer-settings.tsx),
// drawn by every chat box (composer.tsx). A UI preference kept in this
// browser's storage, one entry per person, as the theme is (frame/theme.ts).

/** The accents a person may choose: Grasp's light and two soft colours. */
export const composerAccents = ["default", "mint", "lavender"] as const;

/** The edges a person may choose. */
export const composerEdges = ["smooth", "dither"] as const;

/** How a person's chat box looks at work. */
export interface ComposerLook {
  accent: (typeof composerAccents)[number];
  edge: (typeof composerEdges)[number];
}

const firstLook: ComposerLook = { accent: "default", edge: "smooth" };

/** The change chooseComposerLook tells this tab of; another tab's comes as `storage`. */
const changed = "grasp-composer";

const personKey = (userId: string): string => `grasp-composer:${userId}`;

/** The word a look is kept as: `accent:edge`, the same word while the look is. */
const wordOf = (look: ComposerLook): string => `${look.accent}:${look.edge}`;

/** The look a kept word names; the first where it names none. */
const lookOf = (word: string | null): ComposerLook => {
  const [accent, edge] = (word ?? "").split(":");
  const found = {
    accent: composerAccents.find((each) => each === accent),
    edge: composerEdges.find((each) => each === edge),
  };
  return found.accent === undefined || found.edge === undefined
    ? firstLook
    : { accent: found.accent, edge: found.edge };
};

/** The word `userId` keeps in this browser; none for nobody, or with storage blocked. */
const keptWord = (userId: string | undefined): string | null => {
  if (userId === undefined) {
    return null;
  }
  try {
    return localStorage.getItem(personKey(userId));
  } catch {
    return null;
  }
};

const onLookChange = (onChange: () => void): (() => void) => {
  document.addEventListener(changed, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    document.removeEventListener(changed, onChange);
    window.removeEventListener("storage", onChange);
  };
};

/** Keeps `look` as `userId`'s choice in this browser, and shows it wherever it is drawn. */
export const chooseComposerLook = (
  userId: string,
  look: ComposerLook
): void => {
  try {
    localStorage.setItem(personKey(userId), wordOf(look));
  } catch {
    // Storage blocked: the box keeps the first look.
  }
  document.dispatchEvent(new Event(changed));
};

/** The look `userId` chose in this browser, following a change made anywhere; the first for nobody. */
export const useComposerLook = (userId: string | undefined): ComposerLook =>
  lookOf(
    useSyncExternalStore(
      onLookChange,
      () => keptWord(userId),
      () => null
    )
  );

/** The look of the person signed in here; the first outside the signed-in pages. */
export const useOwnComposerLook = (): ComposerLook =>
  useComposerLook(
    useMatch({ from: "/_shell", shouldThrow: false })?.context.identity.userId
  );
