import { AgentFigure } from "./figure/agent-figure.tsx";
import { lookOfFace } from "./figure/look.ts";

// An agent's picture where only its face is known, as a chat names the
// agent that answered (chat/thread.tsx): its figure, still, at a list's
// size. Decorative: its name stands beside it.

/** An agent's figure, by the face core keeps for it. */
export const AgentAvatar = ({
  face,
  size = "lg",
}: {
  face: string;
  size?: "default" | "lg";
}) => (
  <AgentFigure look={lookOfFace(face)} size={size === "lg" ? "sm" : "xs"} />
);
