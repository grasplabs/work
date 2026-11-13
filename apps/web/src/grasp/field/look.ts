import { useSyncExternalStore } from "react";

// What stands behind Chat's own page: a look, which is a backdrop and, for
// those drawn as a dither, a pattern and a colour. A UI preference, the
// person's own, kept in this browser's storage, one entry per person, as
// the theme is (frame/theme.ts), so someone else signing in here keeps
// theirs. Chosen in Settings (settings/backdrop-settings.tsx).
//
// The backdrops: scenes, each a picture dithered all over; the website's
// shaders, dithered on the page's own ground (silk at dusk, dots on silk,
// the login's glass door); sand on a plate (its figures, dunes, rings, or
// snapped to the dither's grid); or nothing.

/** The scenes: each a picture, dithered all over. */
export const sceneKinds = [
  "cliffs",
  "wave",
  "aurora",
  "starry",
  "fuji",
  "wanderer",
] as const;

export type SceneKind = (typeof sceneKinds)[number];

/** The backdrops drawn as a dither, in a pattern and a colour. */
export const ditherKinds = ["dusk", "dots", "door"] as const;

export type DitherKind = (typeof ditherKinds)[number];

/** The sand backdrops. */
export const sandKinds = ["sand", "dunes", "rings", "pixels"] as const;

export type SandKind = (typeof sandKinds)[number];

export const backdrops = [
  ...sceneKinds,
  ...ditherKinds,
  ...sandKinds,
  "none",
] as const;

export type Backdrop = (typeof backdrops)[number];

/** The dither's patterns, in the order the shader numbers them from 1. */
export const ditherPatterns = ["bayer", "grid", "mix"] as const;

export type DitherPattern = (typeof ditherPatterns)[number];

/** The dither's colours, in the order the shader numbers them from 0. */
export const ditherTones = [
  "light",
  "deep",
  "mint",
  "lime",
  "ink",
  "rim",
  "core",
  "aurora",
] as const;

export type DitherTone = (typeof ditherTones)[number];

/** What stands behind the page: a backdrop, and how it is dithered where it is. */
export interface Look {
  backdrop: Backdrop;
  pattern: DitherPattern;
  tone: DitherTone;
}

/** The look until the person chooses one. */
const firstWord = "sand:bayer:aurora";

const firstLook: Look = { backdrop: "sand", pattern: "bayer", tone: "aurora" };

const personKey = (userId: string): string => `grasp-backdrop:${userId}`;

/** What says a look was chosen in this tab. */
const chosen = "grasp-backdrop";

/** A look as one word, as it is kept. */
const wordOf = ({ backdrop, pattern, tone }: Look): string =>
  `${backdrop}:${pattern}:${tone}`;

/** The look a kept word names; the first where it names none (a backdrop since removed, say). */
const lookOf = (word: string): Look => {
  const [backdrop, pattern, tone] = word.split(":");
  const found = {
    backdrop: backdrops.find((each) => each === backdrop),
    pattern: ditherPatterns.find((each) => each === pattern),
    tone: ditherTones.find((each) => each === tone),
  };
  return found.backdrop === undefined ||
    found.pattern === undefined ||
    found.tone === undefined
    ? firstLook
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
export const chooseLook = (userId: string, look: Look): void => {
  try {
    localStorage.setItem(personKey(userId), wordOf(look));
  } catch {
    // Storage blocked: the first look stays.
  }
  document.dispatchEvent(new Event(chosen));
};

/** The look `userId` chose in this browser, following a change made anywhere. */
export const useLook = (userId: string): Look =>
  lookOf(useSyncExternalStore(onLookChange, () => readWord(userId)));

/** Whether `backdrop` is drawn as a dither, in a pattern and a colour of the person's choosing. */
export const isDithered = (backdrop: Backdrop): backdrop is DitherKind =>
  ditherKinds.some((each) => each === backdrop);

export const isScene = (backdrop: Backdrop): backdrop is SceneKind =>
  sceneKinds.some((each) => each === backdrop);

export const isSand = (backdrop: Backdrop): backdrop is SandKind =>
  sandKinds.some((each) => each === backdrop);

/**
 * The colour scheme what stands on a look takes, so its words read: dark
 * on the scenes, which are night; the page's own on the rest, which are
 * drawn on the page's ground.
 */
export const schemeOf = (look: Look): "dark" | undefined =>
  isScene(look.backdrop) ? "dark" : undefined;
