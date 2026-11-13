import { z } from "zod";

import type { ChatFileInput, ChatFileType } from "./chat.ts";
import type { CompanyToolClass, ToolClassAudience } from "./connect.ts";
import { modelRoles } from "./deployment-config.ts";
import type { ModelRole } from "./deployment-config.ts";
import type { AppClassAudience } from "./stephen-reach.ts";

// The company's agents, as its admins make and change them: each has its
// own name, job and instructions, its own audience and its own classes of
// tools. The organization's own agent, the one every company starts with,
// is the first of them; who reaches it and what it may do stays in
// Settings › Stephen (stephen-reach.ts).

/**
 * The ID of the company's first agent, the one every company starts with:
 * the organization's own, which every chat's agent was before there were
 * others (core's `firstAgentId`).
 */
export const firstAgentId = "organization";

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
  /**
   * The person whose own agent it is: only they see, ask and change it.
   * Null for one of the company's, which its admins make.
   */
  ownerId: string | null;
  /**
   * When its owner offered a person's own agent to the company, for its
   * admins to take on as one of the company's (ISO 8601); null for none
   * offered, and for every company agent.
   */
  offeredAt: string | null;
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

/** Most agents of their own one person keeps. */
export const ownAgentsMax = 10;

/** Most documents one agent keeps. */
export const agentDocumentsMax = 10;

/**
 * A document an admin gave an agent to answer from: a file whose text
 * core read once and keeps, never the file itself. The agent reads it in
 * any chat it answers, as the company's word on its job, so whoever may
 * ask the agent may learn what it says.
 */
export interface AgentDocument {
  id: string;
  /** The file's name, as it was added. */
  name: string;
  type: ChatFileType;
  /** The file's size, in bytes. */
  bytes: number;
  /** When it was added (ISO 8601). */
  addedAt: string;
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
 * What one person's own agents used of the organization's models in a
 * month, for admins: how many they have and what they cost, never what
 * they are called, told or asked.
 */
export interface OwnAgentsUsage {
  personId: string;
  /** How many agents of their own they have now. */
  agents: number;
  /** The UTC month counted, such as `2026-11`. */
  month: string;
  /** US dollars at the providers' list prices, in `month` and the month before. */
  spent: number;
  spentBefore: number;
  /** The requests to a model their agents made in `month`. */
  requests: number;
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
  /**
   * The person's own agents, by name: the ones they made for themselves,
   * which nobody else sees, asks or changes. For anyone.
   */
  ownAgents: () => Promise<Agent[]>;
  /**
   * Makes an agent of the person's own, for anyone: on, theirs alone, in
   * Grasp's own chat only, doing at most what the company lets its first
   * agent do for them. Up to {@link ownAgentsMax} a person.
   */
  makeOwnAgent: (input: AgentInput) => Promise<Agent>;
  /**
   * Offers one of the person's own agents to the company, for its admins
   * to take on (`adoptAgent`), or takes the offer back. Its admins then
   * read what it is and is told, which nobody but its owner did before.
   */
  offerOwnAgent: (agentId: string, offered: boolean) => Promise<void>;
  /** For admins: the agents people offered the company, the oldest offer first. */
  offeredAgents: () => Promise<Agent[]>;
  /**
   * Takes on an agent offered to the company: it becomes one of the
   * company's, on, reaching nobody and with every class for nobody until
   * an admin says otherwise, as one an admin makes. Its owner no longer
   * changes it. The company's own admins only.
   */
  adoptAgent: (agentId: string) => Promise<void>;
  /** Declines an agent offered to the company: it stays its owner's. */
  declineAgent: (agentId: string) => Promise<void>;
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
  /** The documents an agent answers from, the oldest first. Never their text. */
  agentDocuments: (agentId: string) => Promise<AgentDocument[]>;
  /**
   * Gives an agent a document: a file of one of a chat file's types and
   * sizes, up to {@link agentDocumentsMax} an agent. Resolves once its
   * text is read, and is refused with why when it can't be.
   */
  addAgentDocument: (
    agentId: string,
    file: ChatFileInput
  ) => Promise<AgentDocument>;
  /** Takes a document from an agent, for good. */
  removeAgentDocument: (agentId: string, documentId: string) => Promise<void>;
  /**
   * What every agent used of the organization's models this month and the
   * month before, in the order of `agents`.
   */
  agentsUsage: () => Promise<AgentUsage[]>;
  /**
   * For admins: per person with agents of their own, how many, and what
   * they used this month and the month before, the most spent first.
   */
  ownAgentsUsage: () => Promise<OwnAgentsUsage[]>;
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
