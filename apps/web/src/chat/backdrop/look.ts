// What a backdrop is drawn as. Ruben's (the product repo, grasp/field/look.ts), from Damsko's
// cutover (grasplabs/ui 105e94c72), as far as the App cards' grounds draw it (apps/app-card):
// the scenes, each a picture dithered all over, and the website's dithers, which the shader
// (shader.ts) draws beside them.

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
export type BackdropDither = "dusk" | "dots" | "door";

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

/** Whether `backdrop` is a scene: a picture, dithered all over, which is night. */
export const isScene = (
  backdrop: BackdropScene | BackdropDither
): backdrop is BackdropScene => sceneKinds.some((each) => each === backdrop);
