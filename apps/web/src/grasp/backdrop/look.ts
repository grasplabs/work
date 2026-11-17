/** The scenes: each a picture, dithered all over, from night to lime. */
export const sceneKinds = [
  "cliffs",
  "wave",
  "aurora",
  "starry",
  "fuji",
  "wanderer",
] as const;

export type BackdropScene = (typeof sceneKinds)[number];

/** The backdrops drawn as a dither, in a pattern and a colour. */
export const ditherKinds = ["dusk", "dots", "door"] as const;

export type BackdropDither = (typeof ditherKinds)[number];

/** The sand backdrops. */
export const sandKinds = ["sand", "dunes", "rings", "pixels"] as const;

export type BackdropSand = (typeof sandKinds)[number];

/** Every backdrop, in the order a picker lists them. */
export const backdropKinds = [
  ...sceneKinds,
  ...ditherKinds,
  ...sandKinds,
  "none",
] as const;

export type BackdropKind = (typeof backdropKinds)[number];

/** The dither's patterns, in the order the shader numbers them from 1. */
export const ditherPatterns = ["bayer", "grid", "mix"] as const;

export type BackdropPattern = (typeof ditherPatterns)[number];

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

export type BackdropTone = (typeof ditherTones)[number];

/** What stands behind the page: a backdrop, and how it is dithered where it is. */
export interface BackdropLook {
  /** Which backdrop: a scene, a dither, sand, or `"none"`. */
  backdrop: BackdropKind;
  /** How a dither's cells are set. Read only by the dithers. */
  pattern: BackdropPattern;
  /** A dither's colour. Read only by the dithers. */
  tone: BackdropTone;
}

/** The look until the person chooses one: Ruben's first, sand in aurora. */
export const defaultLook: BackdropLook = {
  backdrop: "sand",
  pattern: "bayer",
  tone: "aurora",
};

/** Whether `backdrop` is drawn as a dither, in a pattern and a colour. */
export const isDither = (backdrop: BackdropKind): backdrop is BackdropDither =>
  ditherKinds.some((each) => each === backdrop);

/** Whether `backdrop` is a scene: a picture, dithered all over, which is night. */
export const isScene = (backdrop: BackdropKind): backdrop is BackdropScene =>
  sceneKinds.some((each) => each === backdrop);

/** Whether `backdrop` is sand, drawn on a 2D canvas. */
export const isSand = (backdrop: BackdropKind): backdrop is BackdropSand =>
  sandKinds.some((each) => each === backdrop);

/**
 * The colour scheme what stands on a look takes, so its words read: dark on the scenes, which are
 * night whatever the theme; the page's own (undefined) on the rest, which are drawn on its ground.
 */
export const schemeOf = (
  look: Pick<BackdropLook, "backdrop">
): "dark" | undefined => (isScene(look.backdrop) ? "dark" : undefined);

/**
 * A prop by its new name or its deprecated old one (the breaking release's step 1): the props type
 * requires one of them, so this throws only for a caller outside the types.
 */
export const byNewName = <T>(
  newer: T | undefined,
  older: T | undefined,
  missing: string
): T => {
  const chosen = newer ?? older;
  if (chosen === undefined) {
    throw new Error(missing);
  }
  return chosen;
};
