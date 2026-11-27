/**
 * What an organization's page says of where it stands, from the snapshot
 * its core answered: how long it has been in its standing
 * (src/admin/standing.ts), who each thing that needs Grasp waits on, since
 * when, and the one thing to do about it. Pure.
 */
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { listenDays } from "@grasp-os/shared/admin/onboarding-admin";
import type { Need } from "@grasp-os/shared/admin/onboarding-admin";

import { dayCount, daysBetween, interviewDay } from "./standing.ts";
import type { Standing } from "./standing.ts";

/** The day its interviews closed, or will: the plan's start and its days. */
const interviewsEnd = (snapshot: AdminSnapshot): string | null => {
  if (snapshot.plan === null) {
    return null;
  }
  const end = new Date(`${snapshot.plan.start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + snapshot.plan.days);
  return end.toISOString();
};

/**
 * When the organization came to its standing, as far as what its core
 * answers tells: its go, or the interviews' close for one waiting after
 * them. Null where nothing tells it: when enough came to be known isn't
 * kept, and the interviews count their own days instead.
 */
const standingSince = (
  standing: Standing,
  snapshot: AdminSnapshot
): string | null => {
  switch (standing) {
    case "live": {
      return snapshot.gate.openedAt;
    }
    case "waiting": {
      const end = interviewsEnd(snapshot);
      return end !== null && end <= snapshot.now ? end : null;
    }
    case "setting_up":
    case "interviews":
    case "at_risk":
    case "older":
    case "not_deployed":
    case "unreachable": {
      return null;
    }
    default: {
      return standing satisfies never;
    }
  }
};

/** How long it has been in its standing, in a few words: "For 21 days", "Day 8 of 14". */
export const standingTime = (
  standing: Standing,
  view: AdminView,
  snapshot: AdminSnapshot
): string | null => {
  if (standing === "interviews" || standing === "at_risk") {
    if (view.closed) {
      const end = interviewsEnd(snapshot);
      return end === null
        ? "The interviews closed"
        : `The interviews closed ${dayCount(daysBetween(end, snapshot.now))} ago`;
    }
    return `Day ${interviewDay(view) ?? listenDays(view.org)} of ${listenDays(view.org)}`;
  }
  const since = standingSince(standing, snapshot);
  if (since === null) {
    // Open from the start, as Home says it.
    return standing === "live" ? "Open, without interviews" : null;
  }
  const days = daysBetween(since, snapshot.now);
  // The Badge beside it names the standing: the line says how long.
  return days === 0 ? "Since today" : `For ${dayCount(days)}`;
};

/** Who has to move for a need to be settled. */
export type Party = "grasp" | "company";

/**
 * Who each kind of need waits on. Grasp: its go or its call on opening
 * short, the first conversation, what that left open and what sources
 * disagree on, interviews to read, work heard from too few, resuming
 * paused interviews, and what AI use above the contract means; a contract
 * still being written is Grasp's to send. The company: its agreements, a
 * sent contract to sign, its leads and quiet teams, a sign-in to redo,
 * work its people describe in two ways or that is two workflows, an
 * invoice to pay, and what follows a contract that ends.
 */
export const partyOf = (need: Need): Party => {
  switch (need.kind) {
    case "go":
    case "short":
    case "transcript":
    case "ask":
    case "conflict":
    case "read":
    case "few":
    case "paused":
    case "budget": {
      return "grasp";
    }
    case "contract": {
      return need.sent === null ? "grasp" : "company";
    }
    case "agreement":
    case "lead":
    case "quiet":
    case "signin":
    case "blocked":
    case "split":
    case "overdue":
    case "ending": {
      return "company";
    }
    default: {
      return need satisfies never;
    }
  }
};

export const partyWords: Readonly<Record<Party, string>> = {
  grasp: "Waiting on Grasp",
  company: "Waiting on the company",
};

/**
 * Since when a need has waited, where that is known: the go since the
 * organization was ready, a short close since the interviews closed, a
 * sent contract since it went out. Null where nothing tells it.
 */
export const needSince = (
  need: Need,
  standing: Standing,
  snapshot: AdminSnapshot
): string | null => {
  if (need.kind === "go") {
    return standingSince(standing, snapshot);
  }
  if (need.kind === "short") {
    return interviewsEnd(snapshot);
  }
  if (need.kind === "contract" && need.sent !== null) {
    return need.sent;
  }
  return null;
};

/** The one thing the page asks staff to do about a need, as its button says it. */
export const needAction = (need: Need): string => {
  switch (need.kind) {
    case "go": {
      return "Give the go";
    }
    case "short": {
      return "Decide on opening";
    }
    case "transcript": {
      return "Bring in the conversation";
    }
    case "ask":
    case "conflict": {
      return "See what is open";
    }
    case "paused": {
      return "Resume the interviews";
    }
    case "agreement": {
      return "See the agreements";
    }
    case "lead":
    case "quiet": {
      return "See who has talked";
    }
    case "read": {
      return "Read the interviews";
    }
    case "contract":
    case "ending":
    case "overdue": {
      return "Open the contract";
    }
    case "signin": {
      return "See its connectors";
    }
    case "budget": {
      return "See its AI use";
    }
    case "blocked":
    case "split":
    case "few": {
      return "See the workflows";
    }
    default: {
      return need satisfies never;
    }
  }
};
