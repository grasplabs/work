import { agentFaces } from "@grasp-os/shared/agents";
import type { AgentFace } from "@grasp-os/shared/agents";
import * as stylex from "@stylexjs/stylex";

import { SIGN_PITCH, signFigure } from "../chat/sign-figures.ts";
import type { SignFigure } from "../chat/sign-figures.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// An agent's picture: one of Grasp's dotted sign figures, still, in a
// round tile, as Settings › Stephen draws the first agent's head
// (settings/stephen-avatar.tsx). An admin picks which (agent-form.tsx);
// a name these pages don't know is drawn as the head. Grasp UI's Avatar
// draws a person's picture or initials only, so the tile is drawn here
// at its sizes (xs 20px, for the sidebar's mark; sm 32px; md 40px), on
// its soft fill.

/** The sign figure each face is. */
const figures = {
  stephen: "head",
  brain: "brain",
  pen: "pen",
  lines: "lines",
  flow: "flow",
  check: "check",
} as const satisfies Record<AgentFace, SignFigure>;

const styles = stylex.create({
  tile: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.soft,
    color: grasp.ink,
  },
  xs: { width: "1.25rem", height: "1.25rem" },
  sm: { width: "2rem", height: "2rem" },
  md: { width: "2.5rem", height: "2.5rem" },
  figure: { width: "80%", height: "80%" },
});

/** The face `name` names; the head for any other. */
export const faceOf = (name: string): AgentFace =>
  agentFaces.find((face) => face === name) ?? "stephen";

/** An agent's dotted figure, still, in a round tile; beside its name, so hidden from screen readers. */
export const AgentAvatar = ({
  face,
  size = "md",
}: {
  face: string;
  size?: "xs" | "sm" | "md";
}) => (
  <span aria-hidden="true" {...stylex.props(styles.tile, styles[size])}>
    <svg {...stylex.props(styles.figure)} viewBox="-1.12 -1.12 2.24 2.24">
      {signFigure(figures[faceOf(face)]).map((dot) => (
        <circle
          cx={dot.x}
          cy={-dot.y}
          fill="currentColor"
          key={`${dot.x}:${dot.y}`}
          opacity={0.3 + 0.7 * dot.ink}
          r={SIGN_PITCH * (0.2 + 0.24 * dot.ink)}
        />
      ))}
    </svg>
  </span>
);
