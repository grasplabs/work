import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

// Kept out of agent.ts so reading stored messages doesn't load the agent
// loop (Pi and TypeBox), which a chat loads at its first turn.

/**
 * The tool by which a turn shows its thinking in the brain
 * (agent-thinking.ts), as its stored calls and results name it.
 */
export const showThinkingName = "show_thinking";

/**
 * The agent's tools for what it does most (agent-tools.ts), as their
 * stored calls name them: the chat shows each call as one line.
 */
export const dedicatedToolNames = [
  "createApp",
  "readFile",
  "writeFile",
  "editFile",
  "searchFiles",
  "searchBrain",
  "requestConnection",
  "editWorkflow",
] as const;

export type DedicatedToolName = (typeof dedicatedToolNames)[number];

const dedicatedNames: ReadonlySet<string> = new Set(dedicatedToolNames);

/** Whether `name` is one of the agent's dedicated tools. */
export const isDedicatedTool = (name: string): boolean =>
  dedicatedNames.has(name);

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
