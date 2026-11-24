// The scenes an App card's ground is drawn from (ground.tsx): each a picture, dithered all over
// from night to lime by the shader (shader.ts). Ruben's backdrop scenes (the product repo,
// grasp/field/look.ts), from Damsko's cutover (grasplabs/ui 105e94c72), as far as the cards draw
// them.

/** The scenes: each a picture, dithered all over, from night to lime. */
export const sceneKinds = [
  "cliffs",
  "wave",
  "aurora",
  "starry",
  "fuji",
  "wanderer",
] as const;

export type Scene = (typeof sceneKinds)[number];
