import { Avatar, AvatarFallback } from "@grasp-os/app-kit/components/avatar";
import { agentFaces } from "@grasp-os/shared/agents";
import type { AgentFace } from "@grasp-os/shared/agents";

import { SIGN_PITCH, signFigure } from "../chat/sign-figures.ts";
import type { SignFigure } from "../chat/sign-figures.ts";

// An agent's picture: one of Grasp's dotted sign figures, still, in a
// round tile, as Settings › Stephen draws the first agent's head
// (settings/stephen-avatar.tsx). An admin picks which (agent-form.tsx);
// a name these pages don't know is drawn as the head.

/** The sign figure each face is. */
const figures = {
  stephen: "head",
  brain: "brain",
  pen: "pen",
  lines: "lines",
  flow: "flow",
  check: "check",
} as const satisfies Record<AgentFace, SignFigure>;

/** The face `name` names; the head for any other. */
export const faceOf = (name: string): AgentFace =>
  agentFaces.find((face) => face === name) ?? "stephen";

/** An agent's dotted figure, still, filling the box it stands in (the sidebar's agent level marks its name with it). */
export const AgentFigure = ({ face }: { face: string }) => (
  <svg
    aria-hidden="true"
    height="100%"
    viewBox="-1.12 -1.12 2.24 2.24"
    width="100%"
  >
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
);

/** An agent's dotted figure, still, in an avatar's round tile. */
export const AgentAvatar = ({
  face,
  size = "lg",
}: {
  face: string;
  size?: "default" | "lg";
}) => (
  <Avatar aria-hidden="true" size={size}>
    <AvatarFallback>
      <span className="text-foreground size-4/5">
        <AgentFigure face={face} />
      </span>
    </AvatarFallback>
  </Avatar>
);
