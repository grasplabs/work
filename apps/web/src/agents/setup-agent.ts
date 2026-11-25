import type { Agent, AgentInput } from "@grasp-os/shared/agents";

import type { Session } from "../core.ts";

// The agent a New agent setup makes (manual-agent.tsx, new-agent.tsx),
// before the rest of it is saved call by call. When one of those saves
// fails, the person may change any answer and press Make agent again: the
// agent the earlier try made is deleted and made anew from the answers as
// they are now, so a changed name, job, model or owner never stays behind
// the first try's, and neither does anything that try saved. Its name is
// free again: core frees a deleted agent's name.

/**
 * Makes the agent `input` says, the person's own when `mine`, after
 * deleting `before`, the one an earlier try made; `gone` is told once it
 * is deleted, so a try that fails after that never deletes it twice.
 */
export const makeSetupAgent = async (
  connections: Pick<
    Session["connections"],
    "makeAgent" | "makeOwnAgent" | "deleteAgent"
  >,
  input: AgentInput,
  mine: boolean,
  before: Agent | undefined,
  gone: () => void
): Promise<Agent> => {
  if (before !== undefined) {
    await connections.deleteAgent(before.id);
    gone();
  }
  return mine
    ? await connections.makeOwnAgent(input)
    : await connections.makeAgent(input);
};
