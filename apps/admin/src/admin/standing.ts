/**
 * Where an organization stands, from its summary (core's admin-summary.ts,
 * counts and dates only): the phase of its onboarding, whether it is at
 * risk, and its standing in one word, for Home and an organization's own
 * page alike. Pure.
 */
import type { AdminSummary } from "@grasp-os/shared/admin-summary";
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

/**
 * At risk: the interviews closed short of what it opens at (over, and not
 * enough known), or three quarters of their days are gone and less is
 * known than an even pace towards the threshold would give by now.
 */
export const atRisk = (onboarding: Onboarding): boolean => {
  const { stage, ready, day, days, known, threshold } = onboarding;
  if (stage === "waiting") {
    return !ready;
  }
  if (stage !== "interviews" || day === null || days === null) {
    return false;
  }
  const share = day / days;
  return share >= lateShare && known < threshold * share;
};

/** How organization `entry` stands now. */
export const standingOf = (entry: ClientSummary): Standing => {
  if (entry.state !== "answered") {
    return entry.state;
  }
  const { onboarding } = entry.summary;
  return atRisk(onboarding) ? "at_risk" : phaseOf(onboarding);
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
      return onboarding.ready
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
