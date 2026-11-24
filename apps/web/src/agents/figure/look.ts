import { firstAgentId } from "@grasp-os/shared/agents";

import { figureShapes as agentFigureShapes } from "./body.ts";
import {
  agentFigureOf,
  agentFigurePalettes,
  stephensLook,
} from "./palettes.ts";
import type { AgentFigureLook } from "./palettes.ts";

// An agent's look, on its AgentFigure (agent-figure.tsx): one
// of its shapes in one of its palettes, kept in the agent's `face`, which
// core already holds for it (any `^[a-z][a-z0-9-]{0,39}$`), as
// `figure-<shape>-<palette>`, so a look needs nothing new from core. A new
// agent's look is drawn from its name while it is being made (it has no id
// yet), then kept. Stephen, the company's first agent, is always the
// library's own look for him, with his eye (Ruben's decision 7: fixed).

const facePattern = /^figure-(?<shape>[a-z]+)-(?<palette>[a-z]+)$/u;

/** The look a name draws: the same name, the same look. */
export const lookFromName = (name: string): AgentFigureLook =>
  agentFigureOf(name);

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
  const { shape, palette } = facePattern.exec(face)?.groups ?? {};
  const knownShape = agentFigureShapes.find((each) => each === shape);
  const knownPalette = agentFigurePalettes.find((each) => each === palette);
  if (knownShape !== undefined && knownPalette !== undefined) {
    return { shape: knownShape, palette: knownPalette };
  }
  return lookFromName(name);
};

/** The `face` core keeps for a look. */
export const faceOf = (look: AgentFigureLook): string =>
  `figure-${look.shape}-${look.palette}`;
