import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatAgent } from "@grasp-os/shared/chat";

import { listAgents, listOwnAgents } from "./agent-builder.ts";
import { agentFor } from "./agent-reach.ts";
import { workspaceAgentIdSchema } from "./agent-scope.ts";
import { firstAgentId, turnAgent } from "./agents.ts";
import { modelSettings } from "./models.ts";

// The agents a person may talk to in Grasp's own chat: the company's that
// are on and whose audience takes them in (agent-reach.ts), and their
// own (agents.ts), which nobody else is ever listed. A person
// picks one of these for a new chat; a chat then stays with its agent.
//
// A person never learns of an agent outside their audience: it isn't
// listed, and naming it for a new chat is refused as an agent the company
// doesn't have. Only what a person needs to pick one is handed over, its
// name, face and job, never its instructions.
//
// The ways it can fail, which the tests start from: an agent listed for
// someone outside its audience; a chat made with such an agent, or with a
// paused one, the first agent included, or with an ID that names none; the refusal telling an agent
// that exists from one that doesn't; an agent's instructions on the page.

/** The agents `userId` may talk to in Grasp's own chat, the first one first. */
export const chatAgentsFor = async (
  env: Env,
  userId: string
): Promise<ChatAgent[]> => {
  const [all, own, { models: chosen }] = await Promise.all([
    listAgents(env),
    listOwnAgents(env, userId),
    modelSettings(env),
  ]);
  const on = all.filter(({ state }) => state === "on");
  const reached = await Promise.all(
    on.map(async ({ id }) => {
      const { reaches } = await agentFor(env, id, userId);
      return reaches;
    })
  );
  return [
    ...on.filter((_, index) => reached[index] === true),
    // Their own, after the company's: on, and theirs by their record.
    ...own.filter(({ state }) => state === "on"),
  ].map(({ id, name, face, job, model, ownerId }) => ({
    id,
    name,
    face,
    job,
    // Only one its turns will use (workspace.ts, `#turnModel`).
    model: model !== null && chosen.includes(model) ? model : null,
    own: ownerId !== null,
  }));
};

/**
 * The agent a new chat of `userId`'s is with: the company's first one
 * when none is named, as chats always were, else the one named, when
 * they may talk to it. Throws `agent.paused` for the first agent while
 * it is paused, so no chat is made that it can't answer in, and
 * `agent.unknown` for any other, whether the company has it or not.
 */
export const chatAgentOf = async (
  env: Env,
  userId: string,
  named: unknown
): Promise<string> => {
  if (named === undefined || named === firstAgentId) {
    // Everyone knows of the first agent, so a paused one is refused as
    // paused, which says why and who can turn it back on.
    await turnAgent(env, firstAgentId);
    return firstAgentId;
  }
  const id = workspaceAgentIdSchema.safeParse(named);
  const theirs = id.success ? await chatAgentsFor(env, userId) : [];
  if (!id.success || !theirs.some((agent) => agent.id === id.data)) {
    throw agentErrors.create("agent.unknown");
  }
  return id.data;
};
