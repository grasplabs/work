import type { ChatAgent } from "@grasp-os/shared/chat";

// Which of the company's agents answers, in the box to ask in. A person
// picks an agent by mentioning it (`@`, mentions.tsx), in a new chat or an
// open one. The agents are the ones core lists for this person
// (`chats.agents()`); one that isn't theirs any more answers with no model
// of its own.

/** The model the agent `agentId` answers with, where an admin gave it one. */
export const agentModelOf = (
  agents: readonly ChatAgent[],
  agentId: string | undefined
): string | undefined =>
  agents.find(({ id }) => id === agentId)?.model ?? undefined;
