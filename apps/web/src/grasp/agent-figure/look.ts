// What an agent's figure looks like: one of its shapes (body.ts) in one of the palettes below, each
// palette six tokens (agent-figure-<palette>-<0..5>): the figure's own night, then its five lights
// from deep to bright. `agentFigureOf(seed)` picks a look from any string (an id, a name): the same
// seed always draws the same figure. Pick once, store the look ({ shape, palette }), pass it after.
import { figureShapes } from "./body";
import type { FigureShape } from "./body";

/** The palettes a figure can be drawn in. Evergreen is Stephen's own. */
export const agentFigurePalettes = [
  "evergreen",
  "meadow",
  "ember",
  "amber",
  "ocean",
  "moon",
] as const;

export type AgentFigurePalette = (typeof agentFigurePalettes)[number];

/** A figure's look: its shape and its palette. */
export interface AgentFigureLook {
  shape: FigureShape;
  palette: AgentFigurePalette;
  /** One eye in the middle of its orb: the main agent's alone (`stephensLook`). `agentFigureOf` never gives it. */
  eye?: boolean;
}

/** A palette's six colours, as the tokens that hold them: its night, then its lights, deep to bright. */
export const paletteColours = (
  palette: AgentFigurePalette
): readonly string[] =>
  [0, 1, 2, 3, 4, 5].map(
    (step) => `var(--grasp-agent-figure-${palette}-${String(step)})`
  );

/**
 * A palette's colours at rest, for a paused (asleep) figure: each step pulled most of the way to
 * moon's greys, so it is still this agent's figure, only resting.
 */
export const restingColours = (
  palette: AgentFigurePalette
): readonly string[] =>
  [0, 1, 2, 3, 4, 5].map(
    (step) =>
      `color-mix(in oklch, var(--grasp-agent-figure-${palette}-${String(step)}) 35%, var(--grasp-agent-figure-moon-${String(step)}))`
  );

/** Stephen's own look, the main agent's: an orb in evergreen, looking out with one eye. */
export const stephensLook: AgentFigureLook = {
  shape: "orb",
  palette: "evergreen",
  eye: true,
};

/** A steady number for an id. */
const hashOf = (id: string): number => {
  let hash = 7;
  for (const letter of id) {
    hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return hash;
};

/** The shapes that still read at `xs` (24 pixels): the rest blur into a blot that small. */
export const smallShapes: readonly FigureShape[] = [
  "orb",
  "pair",
  "crescent",
  "eclipse",
  "sun",
  "mushroom",
  "bell",
];

/** What `agentFigureOf` may be told: the size the figure will be drawn at. */
export interface AgentFigureOfOptions {
  /** At `xs` it picks from the shapes that read small: orb, pair, crescent, eclipse, sun, mushroom, bell. */
  size?: "xs" | "sm" | "md" | "lg" | "xl";
}

/**
 * The look a seed keeps (any string: an agent's id or its name): one of the nineteen shapes in one of
 * the six palettes, the same every time. At `xs` it picks from the shapes that read small; the
 * palette is the same at every size. Pick once from the name, store the look, pass it from then on:
 * the face shown while an agent is set up is the face it keeps, whatever it is renamed.
 */
export const agentFigureOf = (
  seed: string,
  options: AgentFigureOfOptions = {}
): AgentFigureLook => {
  const hash = hashOf(seed);
  const shapes = options.size === "xs" ? smallShapes : figureShapes;
  return {
    shape: shapes[hash % shapes.length] ?? "orb",
    palette:
      agentFigurePalettes[
        Math.floor(hash / figureShapes.length) % agentFigurePalettes.length
      ] ?? "evergreen",
  };
};
