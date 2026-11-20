// What an agent looks like: one of the figure's shapes (body.ts) in one of the palettes below. It
// is kept in the agent's `face`, which core already holds for it (any `^[a-z][a-z0-9-]{0,39}$`),
// as `figure-<shape>-<palette>`, so a look needs nothing new from core. An agent made before
// looks were chosen, whose face is still a figure's old name, is given one from its name: the
// same name always draws the same look.
import { firstAgentId } from "@grasp-os/shared/agents";

import { figureShapes } from "./body.ts";
import type { FigureShape } from "./body.ts";

/** The palettes an agent can be given. */
export const figurePalettes = [
  "evergreen",
  "meadow",
  "ember",
  "amber",
  "ocean",
  "moon",
] as const;
export type FigurePalette = (typeof figurePalettes)[number];

/** An agent's look. */
export interface FigureLook {
  shape: FigureShape;
  palette: FigurePalette;
}

const night = "var(--grasp-light-night)";
const paper = "var(--grasp-light-paper)";
const ink = "var(--grasp-light-ink)";
const pine = "var(--grasp-light-pine)";
const mint = "var(--grasp-light-mint)";
const sea = "var(--grasp-light-sea)";
const lime = "var(--grasp-light-lime)";
const heat = "var(--grasp-brain-heat)";
const glow = "var(--grasp-brain-glow)";
const info = "var(--grasp-info)";

/** `a` mixed `share`% into `b`, in the system's colour space. */
const mix = (a: string, share: number, b: string): string =>
  `color-mix(in oklch, ${a} ${String(share)}%, ${b})`;

/**
 * Each palette's colours from Damsko's tokens only: the figure's own night (the ground, dark in
 * either theme), then its five lights from deep to bright. Evergreen is Stephen's own.
 */
export const paletteColours: Record<FigurePalette, readonly string[]> = {
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

const facePattern = /^figure-(?<shape>[a-z]+)-(?<palette>[a-z]+)$/u;

/** A steady number for a name. */
const hashOf = (name: string): number => {
  let hash = 7;
  for (const letter of name) {
    hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return hash;
};

/** The look a name draws when none was chosen. */
export const lookFromName = (name: string): FigureLook => {
  const hash = hashOf(name);
  return {
    shape: figureShapes[hash % figureShapes.length] ?? "orb",
    palette:
      figurePalettes[
        Math.floor(hash / figureShapes.length) % figurePalettes.length
      ] ?? "evergreen",
  };
};

/** Stephen's own look: the company's first agent, until it is given another. */
const stephensOwn: FigureLook = { shape: "orb", palette: "evergreen" };

/**
 * The look an agent's `face` keeps; where it keeps none, Stephen's own for the first agent and
 * one from its name for any other.
 */
export const lookOf = ({
  id,
  face,
  name,
}: {
  id: string;
  face: string;
  name: string;
}): FigureLook => {
  const { shape, palette } = facePattern.exec(face)?.groups ?? {};
  const knownShape = figureShapes.find((each) => each === shape);
  const knownPalette = figurePalettes.find((each) => each === palette);
  if (knownShape !== undefined && knownPalette !== undefined) {
    return { shape: knownShape, palette: knownPalette };
  }
  return id === firstAgentId ? stephensOwn : lookFromName(name);
};

/** The `face` core keeps for a look. */
export const faceOf = (look: FigureLook): string =>
  `figure-${look.shape}-${look.palette}`;
