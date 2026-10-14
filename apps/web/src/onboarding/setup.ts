import type {
  OnboardingProgress,
  Plan,
  Roster,
} from "@grasp-os/shared/onboarding";
import type { KnownPart } from "@grasp-os/shared/onboarding-gate";

import type { ShapeKey } from "../brain/dot-shapes.ts";
import { addDays } from "./send-plan.ts";

// The client onboarding a company's admin goes through until Grasp opens
// (routes/setup.tsx), from the prototype's `lib/onboarding.ts`: the steps,
// the figure the brain takes on each, and how far the interviews are, read
// from what core keeps (the roster, the plan, numbers per team, and how
// much Grasp knows by source). Pure.

export const steps = [
  "welcome",
  "about",
  "company",
  "sources",
  "documents",
  "pulse",
  "leads",
  "team",
  "listening",
  "review",
  "open",
] as const;
export type SetupStep = (typeof steps)[number];

/** The first eight steps are the wizard; after it, the bottom of the screen says where things stand in a word. */
export const wizardSteps = 8;

export const isStep = (value: unknown): value is SetupStep =>
  steps.some((step) => step === value);

export const stepIndex = (step: SetupStep): number => steps.indexOf(step);

/** Where a company keeps its documents, as the onboarding names them. */
export const documentSources = [
  "SharePoint",
  "OneDrive",
  "Microsoft Teams",
  "Google Drive",
  "Confluence",
  "Notion",
] as const;

/** How long the interviews run unless planned otherwise, in days. */
export const listenDays = 14;

/** One team as the brain lays it out: its name and head count. */
export interface SetupTeam {
  id: string;
  name: string;
  people: number;
}

/** The teams that take part, largest first, the way the brain lays them out. */
export const teamsOf = (roster: Roster | null): SetupTeam[] =>
  (roster?.teams ?? [])
    .filter((team) => !team.off)
    .map((team) => ({
      id: team.id,
      name: team.name,
      people:
        roster?.people.filter((person) => person.team === team.id).length ?? 0,
    }))
    .toSorted((a, b) => b.people - a.people);

/** How far the interviews are: numbers only, never who. */
export interface Listening {
  /** How far the days are, 0 to 1. */
  progress: number;
  /** The day of the interviews it is, from 1; 0 before they start. */
  day: number;
  /** How many days they run. */
  days: number;
  leadsHeard: number;
  colleaguesHeard: number;
  /** Per team, in `teamsOf`'s order: people who talked, the lead included. */
  heard: number[];
}

const dayMs = 24 * 60 * 60 * 1000;

/** Whole days from `from` to `to`, both ISO days. */
const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to.slice(0, 10)}T12:00:00Z`) -
      Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) /
      dayMs
  );

/** How far the interviews are on `today`, as core counts them. */
export const listeningOf = (
  {
    roster,
    plan,
    progress,
  }: {
    roster: Roster | null;
    plan: Plan | null;
    progress: OnboardingProgress | null;
  },
  today: string
): Listening => {
  const days = plan?.days ?? listenDays;
  const day =
    plan === null
      ? 0
      : Math.min(Math.max(daysBetween(plan.start, today) + 1, 0), days);
  const byTeam = new Map(progress?.teams.map((team) => [team.id, team]));
  return {
    progress: plan === null ? 0 : Math.min(day / days, 1),
    day,
    days,
    leadsHeard: progress?.leadsTalked ?? 0,
    colleaguesHeard: progress?.talked ?? 0,
    // A team under five shows only whether its lead talked: its own numbers are never shown.
    heard: teamsOf(roster).map(
      ({ id }) =>
        (byTeam.get(id)?.talked ?? 0) +
        (byTeam.get(id)?.leadTalked === true ? 1 : 0)
    ),
  };
};

/** The last day of the interviews. */
export const closesOn = (plan: Pick<Plan, "start" | "days">): string =>
  addDays(plan.start, plan.days - 1);

/** What the brain is drawn from on a step. */
export interface SetupFacts {
  roster: Roster | null;
  listening: Listening;
  /** How much Grasp knows, in percent. */
  known: number;
}

/**
 * The figure the brain takes on each step, and how full it is: the step's
 * context, in dots. Where who is who is known, the figure is the company
 * brain itself with a nerve to each team; where the documents live, a
 * nerve to each place. Nothing is connected there yet, so every place's
 * nerve stays in dashes, and what was known on another step (who is who)
 * stays on the brain as a nerve that runs on beyond the picture.
 */
export const brainScene = (
  step: SetupStep,
  { roster, listening, known }: SetupFacts
): { shape: ShapeKey; fill: number; teams: number[] } => {
  const teams = teamsOf(roster);
  const leads = (roster?.teams ?? []).some(
    (team) => !team.off && team.lead !== null
  );
  const org = (withLeads: boolean): ShapeKey => ({
    kind: "org",
    teams: teams.map((team) => team.people),
    leads: withLeads,
    beyond: 0,
  });
  const shapes: Record<SetupStep, ShapeKey> = {
    welcome: { kind: "head" },
    about: { kind: "head" },
    company: org(false),
    sources: {
      kind: "hub",
      linked: documentSources.map(() => false),
      beyond: roster === null ? 0 : 1,
    },
    documents: { kind: "sheets" },
    pulse: { kind: "laptop" },
    leads: org(leads),
    team: { kind: "crowd" },
    listening: { kind: "listen" },
    review: { kind: "pair" },
    open: { kind: "brain" },
  };
  return {
    shape: shapes[step],
    fill: Math.min(Math.max(known, 0), 100) / 100,
    teams: listening.heard.map((heard, index) => {
      const people = teams[index]?.people ?? 0;
      return people === 0 ? 0 : heard / people;
    }),
  };
};

/** One dot of the bar of what Grasp knows. */
export interface KnownDot {
  filled: boolean;
  /** The next to fill: it breathes. */
  next: boolean;
  /** A new source starts with it. */
  first: boolean;
}

/** Each dot of the bar, in order: whether it is in, whether it is the next to fill, and whether a new source starts with it. */
export const dotsOf = (
  parts: readonly Pick<KnownPart, "weight" | "known">[],
  count: number
): KnownDot[] => {
  const total = parts.reduce((sum, part) => sum + part.weight, 0) || 1;
  const dots: KnownDot[] = [];
  for (const part of parts) {
    const own = Math.round((part.weight / total) * count);
    const filled = Math.round(part.known * own);
    for (let at = 0; at < own; at += 1) {
      dots.push({
        filled: at < filled,
        next: false,
        first: at === 0 && dots.length > 0,
      });
    }
  }
  const next = dots.findIndex((dot) => !dot.filled);
  const dot = dots[next];
  if (dot !== undefined) {
    dot.next = true;
  }
  return dots;
};

/**
 * How long a line takes to say at the pace of speech, in seconds: a steady
 * pace per character, a breath after a comma and a longer one after a full
 * stop. With no voice to say it, a step's way on waits for most of that.
 */
export const readingSeconds = (line: string): number => {
  let at = 0;
  for (const char of line) {
    if (/[.?!…]/u.test(char)) {
      at += 0.34;
    } else if (/[,;:]/u.test(char)) {
      at += 0.18;
    } else {
      at += 0.058;
    }
  }
  return at;
};

/** How far the admin went before: the furthest step, as far as core says they are. */
export const reachedOf = (
  stored: number,
  { plan }: { plan: Plan | null }
): number =>
  Math.min(
    Math.max(stored, plan === null ? 0 : stepIndex("listening")),
    steps.length - 1
  );
