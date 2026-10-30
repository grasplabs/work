import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

// Kept out of agent.ts so reading stored messages doesn't load the agent
// loop (Pi and TypeBox), which a chat loads at its first turn.

const messageRoles = new Set<unknown>([
  "system",
  "user",
  "assistant",
  "toolResult",
]);

/** One of pi's own messages, the only kind the loop makes and keeps. */
export const isMessage = (
  message: AgentMessage | { role?: unknown }
): message is Message => messageRoles.has(message.role);
