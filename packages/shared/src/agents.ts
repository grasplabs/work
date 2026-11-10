import { z } from "zod";

import type { CompanyToolClass, ToolClassAudience } from "./connect.ts";
import { modelRoles } from "./deployment-config.ts";
import type { ModelRole } from "./deployment-config.ts";
import type { AppClassAudience } from "./stephen-reach.ts";

// The company's agents, as its admins make and change them: each has its
// own name, job and instructions, its own audience and its own classes of
// tools. The organization's own agent, the one every company starts with,
// is the first of them; who reaches it and what it may do stays in
// Settings › Stephen (stephen-reach.ts).

/** One of the company's agents, as core keeps it. */
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

/** Most characters an agent's name, job and instructions hold. */
export const agentNameMax = 60;
export const agentJobMax = 200;
export const agentInstructionsMax = 8000;

/** What an admin says of an agent as they make or change it. */
export const agentInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(agentNameMax),
  /** The figure it is drawn with, by its name. */
  face: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  job: z.string().trim().max(agentJobMax),
  instructions: z.string().max(agentInstructionsMax),
  modelRole: z.enum(modelRoles).nullable(),
});
export type AgentInput = z.infer<typeof agentInputSchema>;

/**
 * The agents over `/rpc`, on `connections`: the company's own admins
 * only, never Grasp staff; every change audited.
 */
export interface AgentsApi {
  /** Every agent of the company, the first one first, then by name. */
  agents: () => Promise<Agent[]>;
  /**
   * Makes an agent. It starts on, reaching nobody and with every class
   * off: an admin then says whom it answers and what it may do.
   */
  makeAgent: (input: AgentInput) => Promise<Agent>;
  /** Changes an agent's name, face, job, instructions or model role. */
  changeAgent: (agentId: string, input: AgentInput) => Promise<void>;
  /** Pauses an agent, which then takes no turn, or turns it back on. */
  setAgentPaused: (agentId: string, paused: boolean) => Promise<void>;
  /** Turns an agent on or off for people, and says who may reach it. */
  setAgentReach: (
    agentId: string,
    on: boolean,
    audience: ToolClassAudience
  ) => Promise<void>;
  /** Says for whom an agent has a class: as the company has it, or fewer. */
  setAgentToolClass: (
    agentId: string,
    toolClass: CompanyToolClass,
    audience: AppClassAudience
  ) => Promise<void>;
}
