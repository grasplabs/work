import type { CatalogSource, OAuthProvider } from "@grasp-os/shared/connect";
import type {
  OnboardingProgress,
  Plan,
  Roster,
} from "@grasp-os/shared/onboarding";
import type {
  DocumentSourceId,
  SetupChoices,
} from "@grasp-os/shared/onboarding-choices";
import type { KnownPart } from "@grasp-os/shared/onboarding-gate";

import type { ShapeKey } from "../brain/dot-shapes.ts";
import { lengthOf, readingTiming } from "../voice/timing.ts";
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

/** A place where a company keeps its documents, and the integration Grasp connects it through. */
export interface DocumentSource {
  id: DocumentSourceId;
  name: string;
  /** A suite's own places come with its sign-in; the others connect on their own. */
  suite: OAuthProvider | null;
  integration: { source: CatalogSource; id: string };
}

/** Where a company keeps its documents, as the onboarding names them. */
export const documentSources: readonly DocumentSource[] = [
  {
    id: "sharepoint",
    name: "SharePoint",
    suite: "microsoft",
    integration: { source: "native", id: "microsoft" },
  },
  {
    id: "onedrive",
    name: "OneDrive",
    suite: "microsoft",
    integration: { source: "native", id: "microsoft" },
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    suite: "microsoft",
    integration: { source: "native", id: "microsoft" },
  },
  {
    id: "drive",
    name: "Google Drive",
    suite: "google",
    integration: { source: "native", id: "google" },
  },
  {
    id: "confluence",
    name: "Confluence",
    suite: null,
    integration: { source: "composio", id: "confluence" },
  },
  {
    id: "notion",
    name: "Notion",
    suite: null,
    integration: { source: "composio", id: "notion" },
  },
];

/** The places in the order to offer them: those of the company's sign-in first, the rest as they are. */
export const sourcesFor = (
  signIn: readonly OAuthProvider[]
): DocumentSource[] => [
  ...documentSources.filter(
    ({ suite }) => suite !== null && signIn.includes(suite)
  ),
  ...documentSources.filter(
    ({ suite }) => suite === null || !signIn.includes(suite)
  ),
];

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
  /** What the admin chose about what Grasp may connect. */
  choices: SetupChoices;
}

/**
 * The figure the brain takes on each step, and how full it is: the step's
 * context, in dots. Where who is who is known, the figure is the company
 * brain itself with a nerve to each team; where the documents live, a
 * nerve to each place, drawn once the place is noted and in dashes until
 * then. What was known on another step (who is who, the tools, the HR
 * platform) stays on the brain as a nerve that runs on beyond the picture.
 */
export const brainScene = (
  step: SetupStep,
  { roster, listening, known, choices }: SetupFacts
): { shape: ShapeKey; fill: number; teams: number[] } => {
  const teams = teamsOf(roster);
  const hr = choices.hr?.kind === "platform";
  const leads =
    hr || (roster?.teams ?? []).some((team) => !team.off && team.lead !== null);
  const documents = choices.sources.length > 0 ? 1 : 0;
  const tools = choices.pulse === "wanted" ? 1 : 0;
  const org = (withLeads: boolean): ShapeKey => ({
    kind: "org",
    teams: teams.map((team) => team.people),
    leads: withLeads,
    beyond: documents + tools + (hr ? 1 : 0),
  });
  const shapes: Record<SetupStep, ShapeKey> = {
    welcome: { kind: "head" },
    about: { kind: "head" },
    company: org(false),
    sources: {
      kind: "hub",
      linked: documentSources.map(({ id }) => choices.sources.includes(id)),
      beyond: (roster === null ? 0 : 1) + tools,
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
export const readingSeconds = (line: string): number =>
  lengthOf(readingTiming(line));

/** How far the admin went before: the furthest step, as far as core says they are. */
export const reachedOf = (
  stored: number,
  { plan }: { plan: Plan | null }
): number =>
  Math.min(
    Math.max(stored, plan === null ? 0 : stepIndex("listening")),
    steps.length - 1
  );

/**
 * What only the admin can settle, by id (the prototype's `reviewItems`):
 * letting Grasp's mail through their mail filter, so their people's links
 * don't land in spam. Core keeps none of it; the admin says when it's done.
 */
export const reviewItems = ["mail"] as const;
export type ReviewItemId = (typeof reviewItems)[number];

export const isReviewItem = (value: unknown): value is ReviewItemId =>
  reviewItems.some((item) => item === value);

/** What still needs the admin: every item they haven't settled. */
export const openItems = (settled: readonly ReviewItemId[]): ReviewItemId[] =>
  reviewItems.filter((item) => !settled.includes(item));

/** What this browser keeps of an admin's onboarding: the furthest step they reached, the message they wrote, and what they settled. */
export interface Kept {
  reached: number;
  message: string | null;
  settled: ReviewItemId[];
}

/** What is kept once `item` is settled, or open again. The same object when nothing changed. */
export const settledAs = (
  kept: Kept,
  item: ReviewItemId,
  settled: boolean
): Kept => {
  if (kept.settled.includes(item) === settled) {
    return kept;
  }
  return {
    ...kept,
    settled: settled
      ? [...kept.settled, item]
      : kept.settled.filter((each) => each !== item),
  };
};

/**
 * Grasp's sending domain for the deployment at `hostname`: its client's
 * hostname (`<id>.<domain>`, where the router serves it) with `mail.` in
 * front, the domain the console sets up for Email Sending. Core doesn't
 * tell the web app who its mail is from yet; once it does, that replaces
 * this.
 */
export const sendingDomainOf = (hostname: string): string => `mail.${hostname}`;

/**
 * What is kept once the admin is on step `index`: the furthest step stays
 * the furthest when they go back. The same object when nothing changed.
 */
export const keptAt = (kept: Kept, index: number): Kept =>
  index > kept.reached ? { ...kept, reached: index } : kept;

/**
 * What a team's row says of how many talked, from what core shows of it:
 * the numbers; how many were asked but not yet how many talked, while too
 * few have; or nothing, while too few were asked.
 */
export const teamNumbersOf = (team: {
  talked: number | null;
  asked: number | null;
}):
  | { shown: "both"; talked: number; asked: number }
  | { shown: "asked"; asked: number }
  | { shown: "none" } => {
  if (team.asked === null) {
    return { shown: "none" };
  }
  return team.talked === null
    ? { shown: "asked", asked: team.asked }
    : { shown: "both", talked: team.talked, asked: team.asked };
};
