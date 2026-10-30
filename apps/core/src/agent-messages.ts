import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

// Apart from the agent loop (agent.ts), which a chat loads at its first
// turn: a chat reads its stored messages before then, and the loop brings
// Pi and TypeBox, which core would otherwise load as it starts.

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
