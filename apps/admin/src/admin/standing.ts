/**
 * Where an organization stands, from its summary (core's admin-summary.ts,
 * counts and dates only): the phase of its onboarding, whether it is at
 * risk, and its standing in one word, for Home and, from the snapshot by
 * the same rule, an organization's own page. Pure.
 */
import type { AdminSummary } from "@grasp-os/shared/admin-summary";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { listenDays } from "@grasp-os/shared/admin/onboarding-admin";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";

import type { ClientSummary } from "../clients/summary.ts";

type Onboarding = AdminSummary["onboarding"];

/** Where an organization is on its way to working in Grasp, in the order it goes. */
export const phases = ["setting_up", "interviews", "waiting", "live"] as const;
export type Phase = (typeof phases)[number];

/** How an organization stands: its phase, at risk, or why its summary isn't read. */
export type Standing =
  | Phase
  | "at_risk"
  | "older"
  | "not_deployed"
  | "unreachable";

export const standingWords: Readonly<Record<Standing, string>> = {
  setting_up: "Setting up",
  interviews: "Interviews",
  waiting: "Waiting for the go",
  live: "Live",
  at_risk: "At risk",
  older: "Update to see counts",
  not_deployed: "Being set up",
  unreachable: "Not answering",
};

/** Its Badge: amber for what waits on someone, red for what goes wrong. */
export const standingTones: Readonly<Record<Standing, BadgeVariant>> = {
  setting_up: "default",
  interviews: "info",
  waiting: "warning",
  live: "success",
  at_risk: "destructive",
  older: "warning",
  not_deployed: "default",
  unreachable: "destructive",
};

/** The phase of an onboarding, as its stage says it: open is live, whether or not it onboarded. */
export const phaseOf = ({ stage }: Onboarding): Phase => {
  switch (stage) {
    case "open":
    case "none": {
      return "live";
    }
    case "waiting": {
      return "waiting";
    }
    case "interviews": {
      return "interviews";
    }
    case "preparing": {
      return "setting_up";
    }
    default: {
      return stage satisfies never;
    }
  }
};

/**
 * From this share of the interviews' days on, an organization that knows
 * less than an even pace towards what it opens at would by now is at risk.
 */
const lateShare = 0.75;

/** Where the interviews stand, for whether they are behind. */
interface Pace {
  /** Their days are over. */
  closed: boolean;
  day: number | null;
  days: number | null;
  known: number;
  threshold: number;
}

/**
 * Behind: the interviews closed short of what it opens at (over with less
 * known than its threshold), or three quarters of their days are gone and
 * less is known than an even pace towards the threshold would give by now.
 */
const behind = ({ closed, day, days, known, threshold }: Pace): boolean => {
  if (closed) {
    return known < threshold;
  }
  if (day === null || days === null) {
    return false;
  }
  const share = day / days;
  return share >= lateShare && known < threshold * share;
};

/**
 * At risk, from its summary: its interviews are behind. Waiting for the go
 * is the interviews over or enough known (core's `ready` is true once they
 * are over, whatever is known), so waiting counts as closed.
 */
const atRisk = (onboarding: Onboarding): boolean => {
  const { stage } = onboarding;
  if (stage !== "waiting" && stage !== "interviews") {
    return false;
  }
  return behind({ ...onboarding, closed: stage === "waiting" });
};

/** How organization `entry` stands now. */
export const standingOf = (entry: ClientSummary): Standing => {
  if (entry.state !== "answered") {
    return entry.state;
  }
  const { onboarding } = entry.summary;
  return atRisk(onboarding) ? "at_risk" : phaseOf(onboarding);
};

/**
 * How an organization whose core answered stands, from the admin's view
 * of its snapshot, by the same rule as its summary's (`behind`): its own
 * page reads the snapshot, which says more than the summary. Enough known
 * is waiting for the go; the team told, the interviews, at risk while
 * they are behind.
 */
export const standingOfView = (view: AdminView): Standing => {
  if (view.open) {
    return "live";
  }
  if (view.knowledge.ready) {
    return "waiting";
  }
  if (!view.told) {
    return "setting_up";
  }
  return behind({
    closed: view.closed,
    day: view.day,
    days: listenDays(view.org),
    known: view.knowledge.percent,
    threshold: view.knowledge.threshold,
  })
    ? "at_risk"
    : "interviews";
};

const dayMs = 86_400_000;

/** Whole days from `from` to `to`, never fewer than none. */
export const daysBetween = (from: string, to: string): number =>
  Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / dayMs));

/** "today", "1 day", "9 days". */
export const dayCount = (days: number): string => {
  if (days === 0) {
    return "today";
  }
  return days === 1 ? "1 day" : `${days} days`;
};

/**
 * Where it is within its phase, in a few words: the day of its interviews,
 * how long it has been live, what it waits on.
 */
export const whereWords = (summary: AdminSummary): string => {
  const { onboarding, now } = summary;
  const { day, days, known, threshold } = onboarding;
  const phase = phaseOf(onboarding);
  switch (phase) {
    case "live": {
      if (onboarding.openedAt === null) {
        return "Open, without interviews";
      }
      const since = daysBetween(onboarding.openedAt, now);
      return since === 0 ? "Since today" : `For ${dayCount(since)}`;
    }
    case "waiting": {
      return known >= threshold
        ? "Enough is known"
        : `Closed at ${known}% of ${threshold}%`;
    }
    case "interviews": {
      if (onboarding.paused) {
        return "Interviews paused";
      }
      return day === null || days === null
        ? "Interviews running"
        : `Day ${day} of ${days}`;
    }
    case "setting_up": {
      return onboarding.told ? "The team is told" : "The team isn’t told yet";
    }
    default: {
      return phase satisfies never;
    }
  }
};
