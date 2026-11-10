import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatAgent } from "@grasp-os/shared/chat";

import { listAgents } from "./agent-builder.ts";
import { agentFor } from "./agent-reach.ts";
import { workspaceAgentIdSchema } from "./agent-scope.ts";
import { firstAgentId } from "./agents.ts";

// The company's agents a person may talk to in Grasp's own chat: the ones
// that are on and whose audience takes them in (agent-reach.ts). A person
// picks one of these for a new chat; a chat then stays with its agent.
//
// A person never learns of an agent outside their audience: it isn't
// listed, and naming it for a new chat is refused as an agent the company
// doesn't have. Only what a person needs to pick one is handed over, its
// name, face and job, never its instructions.
//
// The ways it can fail, which the tests start from: an agent listed for
// someone outside its audience; a chat made with such an agent, or with a
// paused one, or with an ID that names none; the refusal telling an agent
// that exists from one that doesn't; an agent's instructions on the page.

/** The agents `userId` may talk to in Grasp's own chat, the first one first. */
export const chatAgentsFor = async (
  env: Env,
  userId: string
): Promise<ChatAgent[]> => {
  const all = await listAgents(env);
  const on = all.filter(({ state }) => state === "on");
  const reached = await Promise.all(
    on.map(async ({ id }) => {
      const { reaches } = await agentFor(env, id, userId);
      return reaches;
    })
  );
  return on
    .filter((_, index) => reached[index] === true)
    .map(({ id, name, face, job }) => ({ id, name, face, job }));
};

/**
 * The agent a new chat of `userId`'s is with: the company's first one
 * when none is named, as chats always were, else the one named, when
 * they may talk to it. Throws `agent.unknown` for any other, whether the
 * company has it or not.
 */
export const chatAgentOf = async (
  env: Env,
  userId: string,
  named: unknown
): Promise<string> => {
  if (named === undefined || named === firstAgentId) {
    return firstAgentId;
  }
  const id = workspaceAgentIdSchema.safeParse(named);
  const theirs = id.success ? await chatAgentsFor(env, userId) : [];
  if (!id.success || !theirs.some((agent) => agent.id === id.data)) {
    throw agentErrors.create("agent.unknown");
  }
  return id.data;
};
