import { useMatch } from "@tanstack/react-router";

import type { ComposerAccent, ComposerEdge } from "../grasp/composer/index.ts";
import { keptWord } from "./kept-word.ts";

// How the chat's box draws Grasp at work, the person's own: the colour of
// its working light and success halo (accent), and how the light's edge
// is drawn (edge), kept as one word, `accent:edge` (kept-word.ts). Chosen
// in Settings, Appearance (settings/composer-settings.tsx); every chat box
// draws it (chat-composer.tsx).

/** The accents a person may choose: Grasp's light and two soft colours. */
export const composerAccents = ["light", "mint", "lavender"] as const;

/** The edges a person may choose. */
export const composerEdges = ["smooth", "dither"] as const;

/** How a person's chat box looks at work. */
export interface ComposerLook {
  accent: (typeof composerAccents)[number] & ComposerAccent;
  edge: (typeof composerEdges)[number] & ComposerEdge;
}

const firstLook: ComposerLook = { accent: "light", edge: "smooth" };

const kept = keptWord(
  "grasp-composer",
  `${firstLook.accent}:${firstLook.edge}`
);

/** The look a kept word names; the first where it names none. */
const lookOf = (word: string): ComposerLook => {
  const [accent, edge] = word.split(":");
  const found = {
    accent: composerAccents.find((each) => each === accent),
    edge: composerEdges.find((each) => each === edge),
  };
  return found.accent === undefined || found.edge === undefined
    ? firstLook
    : { accent: found.accent, edge: found.edge };
};

/** Keeps `look` as `userId`'s choice in this browser, and shows it wherever it is drawn. */
export const chooseComposerLook = (
  userId: string,
  look: ComposerLook
): void => {
  kept.keep(userId, `${look.accent}:${look.edge}`);
};

/** The look `userId` chose in this browser, following a change made anywhere; the first for nobody. */
export const useComposerLook = (userId: string | undefined): ComposerLook =>
  lookOf(kept.useWord(userId));

/** The look of the person signed in here; the first for a guest, whose chat is outside the shell. */
export const useOwnComposerLook = (): ComposerLook =>
  useComposerLook(
    useMatch({ from: "/_shell", shouldThrow: false })?.context.identity.userId
  );
