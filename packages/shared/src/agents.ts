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
  /**
   * The model its turns use, `<provider>/<model>`, one the organization
   * has chosen; null: the model the person asking picked. One the
   * organization no longer has is passed over the same way.
   */
  model: string | null;
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

/**
 * The figures an agent can be drawn with, by name: the dotted head every
 * company's first agent has (`stephen`), and Grasp's other sign figures.
 * What the pages offer; core keeps any name, and one a page doesn't know
 * is drawn as the head.
 */
export const agentFaces = [
  "stephen",
  "brain",
  "pen",
  "lines",
  "flow",
  "check",
] as const;
export type AgentFace = (typeof agentFaces)[number];

/** What an admin says of an agent as they make or change it. */
export const agentInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(agentNameMax),
  /** The figure it is drawn with, by its name. */
  face: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  job: z.string().trim().max(agentJobMax),
  instructions: z.string().max(agentInstructionsMax),
  modelRole: z.enum(modelRoles).nullable(),
  /** The model its turns use; null, or left out, for the asker's own. */
  model: z.string().min(1).max(200).nullable().default(null),
});
/** As an admin sends it: its model may be left out. */
export type AgentInput = z.input<typeof agentInputSchema>;
/** As core reads it: every part said. */
export type AgentSaid = z.output<typeof agentInputSchema>;

/** Whom an agent reaches and for whom it has each class, as core keeps it. */
export interface AgentSettings {
  /** Whether it answers people at all. */
  on: boolean;
  /** Who may reach it. */
  audience: ToolClassAudience;
  /** Every class the company turns on or off, as this agent has it. */
  classes: { toolClass: CompanyToolClass; audience: AppClassAudience }[];
}

/** Most characters a wake-up's opening line holds. */
export const agentWakeOpeningMax = 2000;

/** What an admin says of a wake-up as they make it. */
export const agentWakeInputSchema = z.strictObject({
  /** Five cron fields: minute, hour, day of month, month, day of week. */
  cron: z.string().trim().min(1).max(256),
  /** An IANA time zone; the company's own when not given. */
  timeZone: z.string().min(1).max(64).optional(),
  /** The person it works for: what it finds and wants to change goes to them. */
  personId: z.string().min(1).max(128),
  /** What the agent is asked each time it wakes. */
  opening: z.string().trim().min(1).max(agentWakeOpeningMax),
});
export type AgentWakeInput = z.infer<typeof agentWakeInputSchema>;

/** One of an agent's wake-ups, as core keeps it. */
export interface AgentWake {
  id: string;
  agentId: string;
  cron: string;
  timeZone: string;
  personId: string;
  opening: string;
  state: "on" | "paused";
  /** When it next fires (ISO 8601); null while paused. */
  nextAt: string | null;
  /** When it last fired (ISO 8601), and how that went; null before its first. */
  lastAt: string | null;
  /** `started`, or the code of why its turn didn't start. */
  lastOutcome: string | null;
}

/**
 * What one agent used of the organization's models in a month: how much,
 * never what was asked or by whom.
 */
export interface AgentUsage {
  agentId: string;
  /** The UTC month counted, such as `2026-11`. */
  month: string;
  /** US dollars at the providers' list prices, in `month` and the month before. */
  spent: number;
  spentBefore: number;
  /** The requests to a model it made in `month`: several for one question. */
  requests: number;
  /** How many people it made them for in `month`. */
  people: number;
  /** When it last made one, in either month (ISO 8601); null for none. */
  lastAt: string | null;
}

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
  /**
   * Deletes an agent, for good: it answers nobody, its wake-ups are gone
   * and its name is free again. The chats people had with it stay theirs
   * to read. Never the company's first agent.
   */
  deleteAgent: (agentId: string) => Promise<void>;
  /**
   * Whom an agent reaches and for whom it has each class. Not the first
   * agent's, which Settings › Stephen has.
   */
  agentSettings: (agentId: string) => Promise<AgentSettings>;
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
  /**
   * What every agent used of the organization's models this month and the
   * month before, in the order of `agents`.
   */
  agentsUsage: () => Promise<AgentUsage[]>;
  /** An agent's wake-ups, the oldest first. */
  agentWakes: (agentId: string) => Promise<AgentWake[]>;
  /**
   * Makes a wake-up: at the times its schedule names, the agent takes a
   * turn nobody asked for, for the person named, which only reads. What it
   * wants to change waits for that person.
   */
  makeAgentWake: (agentId: string, input: AgentWakeInput) => Promise<AgentWake>;
  /** Pauses a wake-up, which then doesn't fire, or turns it back on. */
  setAgentWakePaused: (wakeId: string, paused: boolean) => Promise<void>;
  /** Deletes a wake-up. The chat its turns were in stays its person's. */
  deleteAgentWake: (wakeId: string) => Promise<void>;
}
