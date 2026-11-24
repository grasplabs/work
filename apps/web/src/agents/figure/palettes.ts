// What an agent's figure looks like: one of its shapes (body.ts) in one of the palettes below, each
// palette six colours: the figure's own night, then its five lights from deep to bright, mixed from
// Damsko's brand colours (the old library kept them as tokens of its own; they are the figure's
// alone, so they live beside it). `agentFigureOf(seed)` picks a look from any string (an id, a
// name): the same seed always draws the same figure. Pick once, store the look ({ shape, palette }),
// pass it after.
import { colors } from "@grasp-os/ui/lib/tokens.stylex";

import { figureShapes } from "./body.ts";
import type { FigureShape } from "./body.ts";

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

const mix = (a: string, share: number, b: string): string =>
  `color-mix(in oklch, ${a} ${String(share)}%, ${b})`;

const paper = colors.brandPaper;
const night = colors.brandNight;
// The Brain's heat and glow, as the product's other drawings take them.
const heat = "var(--brain-heat)";
const glow = "var(--brain-glow)";

/** Each palette's colours: its night, then its lights, deep to bright. */
const palettes: Record<AgentFigurePalette, readonly string[]> = {
  evergreen: [
    colors.brandInk,
    colors.brandPine,
    colors.brandMint,
    colors.brandSea,
    colors.brandLime,
    paper,
  ],
  meadow: [
    mix(colors.brandPine, 40, night),
    colors.brandPine,
    mix(colors.brandMint, 70, colors.brandLime),
    colors.brandLime,
    mix(colors.brandLime, 50, paper),
    paper,
  ],
  ember: [
    mix(heat, 22, night),
    mix(heat, 60, night),
    heat,
    mix(heat, 45, glow),
    glow,
    mix(glow, 40, paper),
  ],
  amber: [
    mix(glow, 18, night),
    mix(glow, 45, night),
    mix(glow, 75, heat),
    glow,
    mix(glow, 55, paper),
    paper,
  ],
  ocean: [
    mix(colors.info, 22, night),
    mix(colors.info, 55, night),
    colors.info,
    mix(colors.info, 55, colors.brandSea),
    mix(colors.info, 30, paper),
    paper,
  ],
  moon: [
    mix(paper, 10, night),
    mix(paper, 30, night),
    mix(paper, 50, night),
    mix(paper, 70, night),
    mix(paper, 86, night),
    paper,
  ],
};

/** A palette's six colours: its night, then its lights, deep to bright. */
export const paletteColours = (
  palette: AgentFigurePalette
): readonly string[] => palettes[palette];

/**
 * A palette's colours at rest, for a paused (asleep) figure: each step pulled most of the way to
 * moon's greys, so it is still this agent's figure, only resting.
 */
export const restingColours = (
  palette: AgentFigurePalette
): readonly string[] =>
  palettes[palette].map((colour, step) =>
    mix(colour, 35, palettes.moon[step] ?? paper)
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
