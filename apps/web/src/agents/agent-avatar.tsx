import type { ChatAgent } from "@grasp-os/shared/chat";

import { AgentFigure } from "./figure/agent-figure.tsx";
import { lookOf, stephensLook } from "./figure/look.ts";

// An agent's picture beside the answers it gave in a chat (chat/thread.tsx):
// its figure, still, at a list's size, drawn as its page draws it
// (`lookOf`). Decorative: its name stands beside it.

/** An agent's figure; the first agent's for one the chat no longer has. */
export const AgentAvatar = ({
  agent,
  size = "lg",
}: {
  agent: Pick<ChatAgent, "id" | "face" | "name"> | undefined;
  size?: "default" | "lg";
}) => (
  <AgentFigure
    look={agent === undefined ? stephensLook : lookOf(agent)}
    size={size === "lg" ? "sm" : "xs"}
  />
);
