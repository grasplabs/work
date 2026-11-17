// Instructions typed for a new agent that couldn't be saved once the
// agent was made (new-agent.tsx), handed to the agent's page, which opens
// on Instructions with them as the editor's unsaved draft and why they
// weren't saved, so nothing typed is dropped. In this tab's memory alone,
// until the page's route takes them.

/** What was typed, the change its save was tried under, and why it failed. */
export interface UnsavedInstructions {
  text: string;
  change: string;
  failure: string;
}

const kept = new Map<string, UnsavedInstructions>();

/** Keeps `unsaved` for the agent `agentId`'s page. */
export const keepUnsaved = (
  agentId: string,
  unsaved: UnsavedInstructions
): void => {
  kept.set(agentId, unsaved);
};

/** What was kept for the agent `agentId`'s page, once: taken, it is gone. */
export const takeUnsaved = (
  agentId: string
): UnsavedInstructions | undefined => {
  const found = kept.get(agentId);
  kept.delete(agentId);
  return found;
};
