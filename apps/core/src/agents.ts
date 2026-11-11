import type { ModelRole } from "@grasp-os/shared/deployment-config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { workspaceAgentIdSchema } from "./agent-scope.ts";
import { organizationId } from "./auth/membership-sql.ts";
import { agents } from "./db/core/schema.ts";

// The company's agents, as records. Until now there was one agent for
// the whole organization, known only by its ID (`chatAgentId` in
// chats-rpc.ts): admins grant to it, audit events name it, and its
// memory is kept under it. That agent is the first record here, under
// the same ID, so every grant, chat and memory path made before agents
// were records still names it.
//
// Core keeps a row only for an agent an admin made or changed, as its
// other settings do. The first agent has none until then and reads as
// Grasp ships it. Any other ID without a row is no agent at all: nothing
// may run, be granted to or be remembered under an ID nobody made.
//
// This is the read alone. Nothing makes or changes an agent yet, and a
// chat's turn doesn't read its agent here yet.

/** One of the company's agents, as core reads it. */
export interface Agent {
  /** The ID its permissions, audit events and memory path name. */
  id: string;
  /** What people call it. */
  name: string;
  /** The figure it is drawn with. */
  face: string;
  /** One line on what it is for. */
  job: string;
  /** What it is told on top of Grasp's own rules. */
  instructions: string;
  /** The role it asks the gateway for; null: the model a chat uses anyway. */
  modelRole: ModelRole | null;
  /** Whether it answers. */
  state: "on" | "paused";
  /** Who last changed it, and when; null: as Grasp ships it. */
  changedBy: string | null;
  changedAt: string | null;
}

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
  state: "on",
  changedBy: null,
  changedAt: null,
};

/**
 * The agent with this ID, or undefined when the company has none: an ID
 * nobody made, or one that could never be an agent's.
 */
export const readAgent = async (
  env: Env,
  id: string
): Promise<Agent | undefined> => {
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
  return {
    id: row.id,
    name: row.name,
    face: row.face,
    job: row.job,
    instructions: row.instructions,
    modelRole: row.modelRole,
    state: row.state,
    changedBy: row.changedBy,
    changedAt: row.changedAt.toISOString(),
  };
};
