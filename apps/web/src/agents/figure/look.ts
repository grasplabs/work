import { firstAgentId } from "@grasp-os/shared/agents";
import { colors } from "@grasp-os/ui/lib/tokens.stylex";

import { brainColors } from "../../brain/brain-colours.stylex.ts";
import { figureShapes } from "./body.ts";
import type { FigureShape } from "./body.ts";

// What an agent's figure looks like: one of its shapes (body.ts) in one of
// the palettes below, each six colours: the figure's own night, then its
// five lights from deep to bright. A look is kept in the agent's `face`,
// which core already holds for it (any `^[a-z][a-z0-9-]{0,39}$`), as
// `figure-<shape>-<palette>`, so a look needs nothing new from core. A new
// agent's look is drawn from its name while it is being made (it has no id
// yet), then kept. Stephen, the company's first agent, is always his own
// look, with his eye (Ruben's decision 7: fixed).

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
  /** One eye in the middle of its orb: the main agent's alone (`stephensLook`). */
  eye?: boolean;
}

// The warm lights of ember and amber: the Brain's heat and glow.
const { heat, glow } = brainColors;

/** A mix of two colours in oklch, `share` percent of the first. */
const mix = (first: string, share: number, second: string): string =>
  `color-mix(in oklch, ${first} ${String(share)}%, ${second})`;

const ink = colors.brandInk;
const night = colors.brandNight;
const paper = colors.brandPaper;
const pine = colors.brandPine;
const mint = colors.brandMint;
const sea = colors.brandSea;
const lime = colors.brandLime;
const { info } = colors;

/**
 * Each palette's six colours: its night, then its lights, deep to bright.
 * The canvas reads each through the page's styles (live.ts), so a brand
 * colour follows the theme where Damsko's tokens do.
 */
const palettes: Record<AgentFigurePalette, readonly string[]> = {
  evergreen: [ink, pine, mint, sea, lime, paper],
  meadow: [
    mix(pine, 40, night),
    pine,
    mix(mint, 70, lime),
    lime,
    mix(lime, 50, paper),
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
    mix(info, 22, night),
    mix(info, 55, night),
    info,
    mix(info, 55, sea),
    mix(info, 30, paper),
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
 * A palette's colours at rest, for a paused (asleep) figure: each step
 * pulled most of the way to moon's greys, so it is still this agent's
 * figure, only resting.
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

/** A steady number for a seed. */
const hashOf = (seed: string): number => {
  let hash = 7;
  for (const letter of seed) {
    hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return hash;
};

/**
 * The look a seed keeps (any string: an agent's id or its name): one of
 * the shapes in one of the palettes, the same every time. Pick once from
 * the name, store the look, pass it from then on: the face shown while an
 * agent is set up is the face it keeps, whatever it is renamed.
 */
export const lookFromName = (seed: string): AgentFigureLook => {
  const hash = hashOf(seed);
  return {
    shape: figureShapes[hash % figureShapes.length] ?? "orb",
    palette:
      agentFigurePalettes[
        Math.floor(hash / figureShapes.length) % agentFigurePalettes.length
      ] ?? "evergreen",
  };
};

const facePattern = /^figure-(?<shape>[a-z]+)-(?<palette>[a-z]+)$/u;

/** The look a `face` keeps; none for a face that names no look. */
const keptLook = (face: string): AgentFigureLook | undefined => {
  const { shape, palette } = facePattern.exec(face)?.groups ?? {};
  const knownShape = figureShapes.find((each) => each === shape);
  const knownPalette = agentFigurePalettes.find((each) => each === palette);
  return knownShape === undefined || knownPalette === undefined
    ? undefined
    : { shape: knownShape, palette: knownPalette };
};

/** The look an agent's `face` keeps; Stephen's own for the first agent, one from its name where it keeps none. */
export const lookOf = ({
  id,
  face,
  name,
}: {
  id: string;
  face: string;
  name: string;
}): AgentFigureLook => {
  if (id === firstAgentId) {
    return stephensLook;
  }
  return keptLook(face) ?? lookFromName(name);
};

/** The `face` core keeps for a look. */
export const faceOf = (look: AgentFigureLook): string =>
  `figure-${look.shape}-${look.palette}`;
