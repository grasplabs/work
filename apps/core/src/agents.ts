import { agentErrors } from "@grasp-os/shared/agent";
import type { Agent } from "@grasp-os/shared/agents";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { workspaceAgentIdSchema } from "./agent-scope.ts";
import { organizationId } from "./auth/membership-sql.ts";
import { agents } from "./db/core/schema.ts";

// The company's agents, as records. Until now there was one agent for
// the whole organization, known only by its ID (`chatAgentId` in
// chats-rpc.ts): admins grant to it, audit events name it, and its
// instruction file is kept under it. That agent is the first record here,
// under the same ID, so every grant, chat and file made before agents
// were records still names it.
//
// Core keeps a row only for an agent an admin made or changed, as its
// other settings do. The first agent has none until then and reads as
// Grasp ships it. Any other ID without a row is no agent at all: nothing
// may run, be granted to or be remembered under an ID nobody made.
//
// A chat's turn reads its agent here before the model is asked
// (`turnAgent`): one that is paused takes no turn. Nothing makes or
// changes an agent yet.

/**
 * The first agent's ID: the organization's, which every chat's agent has
 * been all along.
 */
export const firstAgentId = organizationId;

/** The first agent until an admin changes it: as Grasp ships it. */
const firstAgent: Agent = {
  id: firstAgentId,
  name: "Stephen",
  face: "stephen",
  job: "Answers from what the company told Grasp, and helps people in their own apps.",
  instructions: "",
  modelRole: null,
  model: null,
  state: "on",
  changedBy: null,
  changedAt: null,
};

/** An agent's row as its record; undefined for one an admin deleted. */
export const agentOfRow = (
  row: typeof agents.$inferSelect
): Agent | undefined =>
  row.state === "deleted"
    ? undefined
    : {
        id: row.id,
        name: row.name,
        face: row.face,
        job: row.job,
        instructions: row.instructions,
        modelRole: row.modelRole,
        model: row.model,
        state: row.state,
        changedBy: row.changedBy,
        changedAt: row.changedAt.toISOString(),
      };

/** What core keeps under an agent's ID: the agent, that it was deleted, or nothing. */
const kept = async (
  env: Env,
  id: string
): Promise<Agent | "deleted" | undefined> => {
  if (!workspaceAgentIdSchema.safeParse(id).success) {
    return undefined;
  }
  const row = await drizzle(env.DB)
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .get();
  if (row === undefined) {
    // A copy: what a caller does to it never reaches the next read.
    return id === firstAgentId ? { ...firstAgent } : undefined;
  }
  return agentOfRow(row) ?? "deleted";
};

/**
 * The agent with this ID, or undefined when the company has none: an ID
 * nobody made, one an admin deleted, or one that could never be an
 * agent's.
 */
export const readAgent = async (
  env: Env,
  id: string
): Promise<Agent | undefined> => {
  const found = await kept(env, id);
  return found === "deleted" ? undefined : found;
};

/**
 * The agent a chat's turn runs as, or undefined for an ID the company
 * keeps no agent under. Throws `agent.paused` for one an admin paused and
 * `agent.unknown` for one an admin deleted: neither takes a turn.
 *
 * An ID nobody ever made still takes its turn, told nothing more: a
 * Workspace object is free to name its own agent, as it always was. A
 * deleted agent's row stays for this, so a chat that still names it is
 * told apart from that.
 */
export const turnAgent = async (
  env: Env,
  id: string
): Promise<Agent | undefined> => {
  const agent = await kept(env, id);
  if (agent === "deleted") {
    throw agentErrors.create("agent.unknown");
  }
  if (agent?.state === "paused") {
    throw agentErrors.create("agent.paused");
  }
  return agent;
};
