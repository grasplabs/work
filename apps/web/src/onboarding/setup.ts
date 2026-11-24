import type { AiProvidersListing } from "@grasp-os/shared/ai-providers";
import type { CatalogSource, OAuthProvider } from "@grasp-os/shared/connect";
import type {
  OnboardingProgress,
  Plan,
  Roster,
} from "@grasp-os/shared/onboarding";
import type { DocumentSourceId } from "@grasp-os/shared/onboarding-choices";
import type { OnboardingContext } from "@grasp-os/shared/onboarding-context";
import { setupSteps } from "@grasp-os/shared/onboarding-flow";
import type { SetupPlace } from "@grasp-os/shared/onboarding-flow";

import { lengthOf, readingTiming } from "../voice/timing.ts";
import { addDays } from "./send-plan.ts";

// The setup a company's admin goes through until Grasp opens
// (routes/setup.tsx): the steps, where the admin is on them, and how far
// the interviews are, read from what core keeps (the roster, the plan and
// numbers per team). Pure.

/** The onboarding's screens, in order: core keeps which of them the admin finished, by these names. */
export const steps = setupSteps;
export type SetupStep = (typeof steps)[number];

/**
 * The screens one company's admin goes through, in order: those its flow
 * has (`flowScreens`), all of them in `steps`' order for the whole
 * onboarding. Every place below is a place on it, from 0.
 */
export type SetupPath = readonly SetupStep[];

export const isStep = (value: unknown): value is SetupStep =>
  steps.some((step) => step === value);

/** Where `step` is on `path`, from 0; -1 for a screen the company's flow doesn't have. */
export const stepIndex = (step: SetupStep, path: SetupPath = steps): number =>
  path.indexOf(step);

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

/** What the kickoff named of where the company works: its suites and its places. */
export type Named = Pick<OnboardingContext, "suites" | "sources">;

/** Nothing named: everything is offered, as for anyone. */
const namedNothing: Named = { suites: [], sources: [] };

/**
 * The suites to offer of those `offered`, as the kickoff named them (a
 * company that works in Google isn't offered Microsoft): those it named,
 * when it named any of them; all of them otherwise.
 */
export const suitesFor = <Suite extends OAuthProvider>(
  offered: readonly Suite[],
  named: Named = namedNothing
): Suite[] => {
  const kept = offered.filter((suite) => named.suites.includes(suite));
  return kept.length > 0 ? kept : [...offered];
};

/**
 * The places in the order to offer them: those the kickoff named first,
 * then those of the company's sign-in, then the rest. Where the kickoff
 * named the suites the company works in, another suite's places aren't
 * offered, unless already `noted`.
 */
export const sourcesFor = (
  signIn: readonly OAuthProvider[],
  named: Named = namedNothing,
  noted: readonly DocumentSourceId[] = []
): DocumentSource[] => {
  const offered = documentSources.filter(
    ({ id, suite }) =>
      named.suites.length === 0 ||
      suite === null ||
      named.suites.includes(suite) ||
      noted.includes(id)
  );
  const rank = ({ id, suite }: DocumentSource): number => {
    if (named.sources.includes(id)) {
      return 0;
    }
    return suite !== null && signIn.includes(suite) ? 1 : 2;
  };
  return offered.toSorted((one, other) => rank(one) - rank(other));
};

/** How long the interviews run unless planned otherwise, in days. */
const listenDays = 14;

/** One team that takes part: its name and head count. */
interface SetupTeam {
  id: string;
  name: string;
  people: number;
}

/** The teams that take part, largest first. */
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
  { plan }: { plan: Plan | null },
  path: SetupPath = steps
): number =>
  Math.min(
    // A plan saved means the team is being listened to, where the flow has that.
    Math.max(stored, plan === null ? 0 : stepIndex("listening", path), 0),
    Math.max(path.length - 1, 0)
  );

/**
 * How far core says the admin went: the first screen of the path they
 * haven't finished, wherever they finished the others; the last, once
 * every one is. So a screen the flow gained, or one moved ahead of where
 * they were, is the one they go on from, and is never counted as seen. A
 * screen finished that the flow no longer has counts for nothing.
 */
export const reachedByPlace = (
  place: SetupPlace | null,
  path: SetupPath = steps
): number => {
  const done = place?.done ?? [];
  const first = path.findIndex((step) => !done.includes(step));
  return first === -1 ? Math.max(path.length - 1, 0) : first;
};

/** The screens finished by an admin who went as far as `reached`: every one before it. */
export const finishedAt = (
  reached: number,
  path: SetupPath = steps
): SetupStep[] => path.slice(0, Math.max(reached, 0));

/**
 * Where the admin can go from step `index`, having been as far as
 * `reached`: back a step always, and on a step only as far as they have
 * been. The frame's two arrows go by it.
 */
export const waysFrom = (
  index: number,
  reached: number,
  path: SetupPath = steps
) => ({
  back: path[index - 1],
  on: index < reached ? path[index + 1] : undefined,
});

/**
 * What only the admin can settle, by id (the prototype's `reviewItems`):
 * letting Grasp's mail through their mail filter, so their people's links
 * don't land in spam. Core keeps none of it; the admin says when it's done.
 */
export const reviewItems = ["mail"] as const;
export type ReviewItemId = (typeof reviewItems)[number];

export const isReviewItem = (value: unknown): value is ReviewItemId =>
  reviewItems.some((item) => item === value);

/**
 * What Grasp's AI has to call, as the AI step reads it: the providers an
 * admin can connect with their models, those connected, and whether a
 * model is ready for calls. Only the admin can make it ready, on the AI
 * step or in Settings › AI providers; core says once it is.
 */
export interface AiReadiness {
  listing: AiProvidersListing;
  ready: boolean;
}

/**
 * How far an admin can be, having been as far as `reached`: no further
 * than the AI step while no model is ready for calls, since every step
 * after it has Grasp's AI read or talk (`ai`; null when core can't say,
 * which holds nothing up). StepperNav and the address go by it, so the
 * step can't be passed without a model.
 */
export const heldAt = (
  reached: number,
  ai: Pick<AiReadiness, "ready"> | null,
  path: SetupPath = steps
): number => {
  const at = stepIndex("ai", path);
  // A flow without the AI step holds nobody: its admin sets it in Settings.
  return ai?.ready === false && at !== -1 ? Math.min(reached, at) : reached;
};

/**
 * The step shown: the one `asked` for in the address, or without one
 * where they were; and the AI step instead of any step after it while no
 * model is ready for calls. A screen the company's flow doesn't have is
 * never shown: where they were stands in for it.
 */
export const stepShown = (
  asked: SetupStep | undefined,
  reached: number,
  ai: Pick<AiReadiness, "ready"> | null,
  path: SetupPath = steps
): SetupStep => {
  const held = heldAt(reached, ai, path);
  const at = asked === undefined ? -1 : stepIndex(asked, path);
  if (asked !== undefined && at !== -1 && (held === reached || at <= held)) {
    return asked;
  }
  return path[held] ?? path[0] ?? "welcome";
};

/**
 * Where the AI step goes on to: the screen after it, or for an admin who
 * was sent back to it, the furthest step they `reached` before; none
 * where it is the flow's last screen.
 */
export const afterAi = (
  reached: number,
  path: SetupPath = steps
): SetupStep | undefined => {
  const next = stepIndex("ai", path) + 1;
  return path[Math.max(reached, next)] ?? path[next];
};

/**
 * What still needs the admin: every item they haven't settled. Where
 * Grasp sends no mail (`mailSends`), there's no mail to let through.
 */
export const openItems = (
  settled: readonly ReviewItemId[],
  mailSends: boolean
): ReviewItemId[] =>
  reviewItems.filter(
    (item) => !settled.includes(item) && (item !== "mail" || mailSends)
  );

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
