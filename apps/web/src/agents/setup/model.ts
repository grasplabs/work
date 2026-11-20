import type { CompanyToolClass } from "@grasp-os/shared/connect";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";

import type { AgentTemplate } from "../agent-templates.ts";

// What New agent's guided setup knows (manual-agent.tsx): its steps, the
// agent as the answers so far have it, and what every step is handed.
// Each step is a file of its own beside this one, so each can be shaped
// on its own; this file is the contract between them.

/** The steps, in the order they are asked. */
export const steps = [
  "audience",
  "name",
  "job",
  "instructions",
  "apps",
  "abilities",
  "thinking",
  "schedule",
  "review",
] as const;
export type Step = (typeof steps)[number];

/**
 * The steps only one of the company's agents is asked: an agent of the
 * person's own has no kinds of work of its own and never works on its own
 * (core's agents.ts).
 */
export const companySteps: ReadonlySet<Step> = new Set([
  "abilities",
  "schedule",
]);

/** What it may do: three reaches of its own, and three kinds of work. */
export const abilities = [
  "web",
  "workflows",
  "apps",
  "read",
  "change",
  "reach",
] as const;
export type Ability = (typeof abilities)[number];

/** The company's classes each kind of work turns on (core's tool classes). */
export const classesOf: Partial<Record<Ability, readonly CompanyToolClass[]>> =
  {
    read: ["read-own", "read-company"],
    change: ["change-own", "change-company"],
    reach: ["reach-others", "read-others"],
  };

/** What it may do from the start: reading on, changing and reaching others off (decision 8). */
export const startsWith: ReadonlySet<Ability> = new Set([
  "web",
  "workflows",
  "apps",
  "read",
]);

/** How hard it thinks, lowest first. */
export const efforts = ["low", "medium", "high", "extra", "max"] as const;
export type Effort = (typeof efforts)[number];

/** How often it works on its own; `asked` is never. */
export const frequencies = ["asked", "daily", "weekly", "monthly"] as const;
export type Frequency = (typeof frequencies)[number];

/** When it works on its own: how often, on which days, at what time. */
export interface Schedule {
  frequency: Frequency;
  /** For `weekly`: the days it works, 0 for Sunday to 6 for Saturday. */
  days: ReadonlySet<number>;
  /** For `monthly`: the day of the month, 1 to 28 so every month has it. */
  dayOfMonth: number;
  /** The time, `HH:MM`, in the company's time zone. */
  time: string;
}

const timeOfDay = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u;

/**
 * The schedule as core keeps it, five cron fields; undefined when it never
 * runs on its own, or when it can't run (no time, no day).
 */
export const cronOfSchedule = (schedule: Schedule): string | undefined => {
  const { hour, minute } = timeOfDay.exec(schedule.time)?.groups ?? {};
  if (
    schedule.frequency === "asked" ||
    hour === undefined ||
    minute === undefined
  ) {
    return undefined;
  }
  const at = `${String(Number(minute))} ${String(Number(hour))}`;
  if (schedule.frequency === "daily") {
    return `${at} * * *`;
  }
  if (schedule.frequency === "monthly") {
    return `${at} ${String(schedule.dayOfMonth)} * *`;
  }
  if (schedule.days.size === 0) {
    return undefined;
  }
  const days = [...schedule.days].toSorted((a, b) => a - b).join(",");
  return `${at} * * ${days}`;
};

/** Who may use it: `me` makes one of the person's own (core's `makeOwnAgent`). */
export const audiences = ["me", "teams", "everyone"] as const;
export type Audience = (typeof audiences)[number];

/** An app the agent can be given: one from the company's catalog, connected or not yet. */
export interface CatalogApp {
  /** The catalog's id for it, which a connection's `provider` names. */
  id: string;
  /** Where the catalog has it from (`native`, `composio`): with `id`, the app an agent is given (`agentAppOf`). */
  source: string;
  name: string;
  logo: string | null;
  description: string | null;
  categories: readonly string[];
  /** Whether it is connected and working, for the person or the company. */
  connected: boolean;
  /** The account it is connected as, such as an email address. */
  account: string | null;
}

/** The agent as the answers so far have it. */
export interface Setup {
  template: string | undefined;
  name: string;
  job: string;
  /**
   * Its instructions, one Markdown text in the five parts of agent-brief.ts
   * (a heading a part), as Grasp proposed them and the person changed them.
   */
  instructions: string;
  /** Its goal, as proposed: the summary's first row. */
  goal: string;
  /** Whether the instructions were changed by hand, so a new job leaves them be. */
  instructionsTouched: boolean;
  /** The apps it may use, by their catalog id. */
  apps: ReadonlySet<string>;
  abilities: ReadonlySet<Ability>;
  /** The model its turns use; null for the one the person picks in the chat. */
  model: string | null;
  effort: Effort;
  schedule: Schedule;
  audience: Audience;
  teams: ReadonlySet<string>;
}

export const blank: Setup = {
  template: undefined,
  name: "",
  job: "",
  instructions: "",
  goal: "",
  instructionsTouched: false,
  apps: new Set(),
  abilities: startsWith,
  model: null,
  effort: "medium",
  schedule: {
    frequency: "asked",
    days: new Set([1, 2, 3, 4, 5]),
    dayOfMonth: 1,
    time: "09:00",
  },
  audience: "me",
  teams: new Set(),
};

/** What every step is handed. */
export interface StepProps {
  setup: Setup;
  /** Changes part of the setup. */
  change: (next: Partial<Setup>) => void;
  /** The agent's name, trimmed: every question says it. */
  name: string;
  /** The company's catalog of apps, connected ones marked. */
  apps: readonly CatalogApp[];
  teams: StephenReach["teams"];
  /** The models the organization chose, which an agent can be given. */
  models: readonly string[];
  /** Whether another agent has the name typed. */
  nameTaken: boolean;
  /** Takes a starting point and goes on to the next question. */
  pick: (template: AgentTemplate) => void;
  /** Who it may be for: `me` only while the company lets people have agents of their own. */
  audiences: readonly Audience[];
}

/** A copy of `set` with `value` in it or out of it. */
export const toggled = <T>(
  set: ReadonlySet<T>,
  value: T,
  on: boolean
): Set<T> => {
  const next = new Set(set);
  if (on) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return next;
};
