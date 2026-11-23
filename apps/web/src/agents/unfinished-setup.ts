// What a new agent's setup couldn't finish once the agent was made
// (manual-agent.tsx, new-agent.tsx): its apps, its kinds of work, whom it
// answers or its schedule, each set by a call of its own after the agent
// is made. The agent exists by then, and its name is taken, so the setup
// never offers to make it again: its page opens and says what failed, so
// the rest is set there. In this tab's memory alone, by the agent's ID,
// until the page's alert is closed.

const kept = new Map<string, string>();

/** Keeps why the setup of the agent `agentId` stopped, for its page. */
export const keepUnfinished = (agentId: string, failure: string): void => {
  kept.set(agentId, failure);
};

/** Why the setup of the agent `agentId` stopped; undefined when it didn't. */
export const unfinishedOf = (agentId: string): string | undefined =>
  kept.get(agentId);

/** Forgets it, once its page's alert is closed. */
export const forgetUnfinished = (agentId: string): void => {
  kept.delete(agentId);
};
