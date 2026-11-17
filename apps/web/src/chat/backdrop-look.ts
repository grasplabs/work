import {
  backdropKinds,
  defaultLook,
  ditherPatterns,
  ditherTones,
} from "../grasp/backdrop/index.ts";
import type { BackdropLook } from "../grasp/backdrop/index.ts";
import { keptWord } from "./kept-word.ts";

// What stands behind Chat's start: the person's look (Grasp UI's
// BackdropLook: a backdrop and, for a dither, its pattern and colour),
// kept as one word, `backdrop:pattern:tone` (kept-word.ts). Chosen in
// Settings, Appearance (settings/backdrop-settings.tsx).

/** A look as one word, as it is kept. */
const wordOf = ({ backdrop, pattern, tone }: BackdropLook): string =>
  `${backdrop}:${pattern}:${tone}`;

const kept = keptWord("grasp-backdrop", wordOf(defaultLook));

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

/** Keeps `look` as `userId`'s choice in this browser, and shows it wherever it is drawn. */
export const chooseLook = (userId: string, look: BackdropLook): void => {
  kept.keep(userId, wordOf(look));
};

/** The look `userId` chose in this browser, following a change made anywhere. */
export const useLook = (userId: string): BackdropLook =>
  lookOf(kept.useWord(userId));
