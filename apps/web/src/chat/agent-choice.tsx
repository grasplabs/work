import type { ChatAgent } from "@grasp-os/shared/chat";

import type { ComposerAgentOption } from "../grasp/composer/index.ts";

// Which of the company's agents answers, chosen in the box's plus menu
// (Grasp UI's ComposerAdd). A person with one agent sees nothing of it, as
// before there were more. A new chat's box picks one, the company's first
// unless another is chosen, which then shows above the text; an open
// chat stays with its agent, so its box offers none. The agents are the
// ones core lists for this person (`chats.agents()`).

/** The agent a new chat starts with: the one picked, while it is still theirs, else the first. */
export const startingAgent = (
  agents: readonly ChatAgent[],
  picked?: string
): ChatAgent | undefined =>
  agents.find(({ id }) => id === picked) ?? agents.at(0);

/** The model the agent `agentId` answers with, where an admin gave it one. */
export const agentModelOf = (
  agents: readonly ChatAgent[],
  agentId: string | undefined
): string | undefined =>
  agents.find(({ id }) => id === agentId)?.model ?? undefined;

/**
 * The agents as the box's plus menu offers them (Grasp UI's ComposerAdd):
 * none where the person has only one, as before there were more.
 */
export const agentOptions = (
  agents: readonly ChatAgent[]
): ComposerAgentOption[] =>
  agents.length < 2
    ? []
    : agents.map(({ id, name, job }) => ({
        value: id,
        label: name,
        avatar: true,
        ...(job === "" ? {} : { description: job }),
      }));
