import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// Stephen's tour of the platform, as the prototype's script has it
// (grasplabs/prototype `lib/tour-script.ts`): his lines, the pages he
// takes in the sidebar's order, and the place he can always be asked last.
// Text only: his voice waits on the voice work. The prototype's Apps stop
// is left out, as Apps are Domains here (routes/_shell.apps.index.tsx), and
// so is its one-workflow stop, which the prototype has switched off.

/** The stops there are. */
export type TourStop =
  | "brain"
  | "domains"
  | "workflows"
  | "integrations"
  | "chat";

/** The pages a stop goes to, by the sidebar. */
export type TourPage = "/brain" | "/domains" | "/workflows" | "/integrations";

/** What the tour knows of the person: what their role lets them see. */
export interface TourViewer {
  role: string;
  staff: boolean;
  /** Grasp staff who reach the onboarding alone (app-sidebar.tsx). */
  onboardingOnly?: true;
}

interface ScriptStop {
  id: TourStop;
  /** The page he goes to; none for the last stop, said where he is. */
  page: TourPage | null;
  /** The sidebar link he points at, by its address; none where he points at himself. */
  points: string | null;
  say: MessageDescriptor;
  /** Whether the person's role shows them what this stop is about. */
  shownTo: (viewer: TourViewer) => boolean;
}

/**
 * The product's sections are in the sidebar for everyone but staff who
 * reach the onboarding alone, as app-sidebar.tsx lists them.
 */
const seesSections = (viewer: TourViewer): boolean =>
  viewer.onboardingOnly !== true;

/** The small question on Home that offers the tour, the first time. */
export const tourOffer = {
  say: msg`Welcome to Grasp. Shall I show you around? It takes about a minute.`,
  start: msg`Start the tour`,
  later: msg`Not now`,
};

/** How every tour begins, the first one and one asked for from the menu. */
export const tourOpening = {
  say: msg`Hey, great to have you here. This can all be a little overwhelming, so I’ll bring you up to speed in just one minute. Are you ready?`,
  ready: msg`I’m ready`,
  later: msg`Not now`,
};

/** The stops, in the order he takes them. */
const script: readonly ScriptStop[] = [
  {
    id: "brain",
    page: "/brain",
    points: "/brain",
    say: msg`This is the Brain. Everything I learn about your company comes together here. Every answer and every workflow is built on it.`,
    shownTo: seesSections,
  },
  {
    id: "domains",
    page: "/domains",
    points: "/domains",
    say: msg`These are your domains. Each one is a part of your business, with its workflows, apps and integrations together.`,
    shownTo: seesSections,
  },
  {
    id: "workflows",
    page: "/workflows",
    points: "/workflows",
    say: msg`This is the work itself, one workflow for each piece of work. You see where the time goes, and what I can take off your hands.`,
    shownTo: seesSections,
  },
  {
    id: "integrations",
    page: "/integrations",
    points: "/integrations",
    say: msg`On this page you connect the applications your organization works in. They are the platform’s instruments to build what you need.`,
    shownTo: seesSections,
  },
  {
    // The last stop is himself, in the chat box's place, where he can be
    // asked from any page.
    id: "chat",
    page: null,
    points: null,
    say: msg`That’s the tour. Ask me anything, on any page. You’ll find me right here.`,
    shownTo: seesSections,
  },
];

const scriptOf = (stop: TourStop): ScriptStop => {
  const found = script.find(({ id }) => id === stop);
  if (found === undefined) {
    throw new Error(`The tour has no stop ${stop}`);
  }
  return found;
};

/** The stops `viewer` takes, in order: none their role doesn't show them. */
export const tourStops = (viewer: TourViewer): TourStop[] =>
  script.filter((stop) => stop.shownTo(viewer)).map(({ id }) => id);

/** The page a stop is on; none for the last, said where he is. */
export const pageOf = (stop: TourStop): TourPage | null => scriptOf(stop).page;

/** The address of the sidebar link a stop points at, if it points at one. */
export const pointsAt = (stop: TourStop): string | null =>
  scriptOf(stop).points;

/** What he says at a stop. */
export const lineOf = (stop: TourStop): MessageDescriptor => scriptOf(stop).say;

/** The pages a tour goes to: going anywhere else ends it. */
export const tourPages: readonly string[] = [
  "/",
  ...script.flatMap(({ page }) => (page === null ? [] : [page])),
];

/**
 * Whether the tour is offered by itself now: once, to someone it has
 * stops for, who wasn't offered it in this browser before (`seen`) or in
 * this visit (`asked`).
 */
export const tourDue = ({
  viewer,
  seen,
  asked,
}: {
  viewer: TourViewer;
  seen: boolean;
  asked: boolean;
}): boolean => !seen && !asked && tourStops(viewer).length > 0;

/**
 * Where a step from `at` lands among `stops` stops: `"end"` on from the
 * last one, the first back from the first.
 */
export const stopBeside = (
  at: number,
  step: 1 | -1,
  stops: number
): number | "end" => {
  const next = at + step;
  if (next >= stops) {
    return "end";
  }
  return Math.max(0, next);
};
