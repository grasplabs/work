import {
  leadWaitWorkingDays,
  minTalkedShown,
  minTeamShown,
} from "@grasp-os/shared/onboarding";
import type {
  Agreements,
  OnboardingProgress,
  Plan,
  Roster,
  RosterPerson,
  TeamProgress,
} from "@grasp-os/shared/onboarding";

// The onboarding's rules, as pure functions of what the store holds: whose
// links are due, and what the company's admin may see of where the
// interviews stand. Ported from the prototype (grasplabs/prototype,
// packages/grasp: src/lib/org-record.ts).

/** Where one interview stands, without what was said in it. */
export interface InterviewState {
  person: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** The day an ISO time falls on, as an ISO day. */
export const dayOf = (time: string): string => time.slice(0, 10);

/** The ISO day `count` days after `day`. */
export const addDays = (day: string, count: number): string => {
  const date = new Date(`${dayOf(day)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};

const saturday = 6;
const sunday = 0;

/** The ISO day `count` working days after `day`: weekends don't count. */
export const addWorkingDays = (day: string, count: number): string => {
  let at = dayOf(day);
  let left = count;
  while (left > 0) {
    at = addDays(at, 1);
    const weekday = new Date(`${at}T12:00:00Z`).getUTCDay();
    if (weekday !== saturday && weekday !== sunday) {
      left -= 1;
    }
  }
  return at;
};

/** The last day of the interviews. */
export const closesOn = (plan: Plan): string =>
  addDays(plan.start, plan.days - 1);

/** When a team's links start to go out (ISO time): `null` while its turn isn't planned. */
export const sendsFrom = (plan: Plan, team: string): string | null => {
  const own = plan.later?.[team];
  if (own !== undefined) {
    return own;
  }
  return plan.at ?? `${plan.start}T00:00:00.000Z`;
};

/** Whether someone takes part: their team does, and they aren't away. */
export const takingPart = (roster: Roster, person: RosterPerson): boolean => {
  const team = roster.teams.find((each) => each.id === person.team);
  return team !== undefined && !team.off && !person.away;
};

/** Whether someone leads a team. */
export const leads = (roster: Roster, person: string): boolean =>
  roster.teams.some((team) => team.lead === person);

/**
 * Whether interviews may happen: the data processing agreement and the
 * risk assessment in place, and the works council agreed or not there.
 */
export const agreementsIn = (agreements: Agreements | null): boolean =>
  agreements !== null &&
  agreements.processing &&
  agreements.assessment &&
  agreements.council !== "waiting";

/** What links depend on beside the roster and the plan. */
export interface LinkFacts {
  /** People whose link went out already. */
  sent: ReadonlySet<string>;
  interviews: ReadonlyMap<string, InterviewState>;
  /** Teams whose lead's map of the work is drawn. */
  mapped: ReadonlySet<string>;
}

/** Whether a team's lead is someone who will talk: there, and not away. */
const leadOf = (roster: Roster, team: string): RosterPerson | undefined => {
  const lead = roster.teams.find((each) => each.id === team)?.lead;
  return roster.people.find((each) => each.id === lead && !each.away);
};

/**
 * Whether one person's link is due by `now`. A lead's at their team's
 * moment, and so is everyone's in a team without a lead. Everyone else's
 * once their lead has agreed to their interview and the team's work is
 * mapped; or, when the lead hasn't, `leadWaitWorkingDays` after the team's
 * moment, and Stephen asks them what work they do.
 */
const isDue = (
  roster: Roster,
  plan: Plan,
  facts: LinkFacts,
  person: RosterPerson,
  now: string
): boolean => {
  if (!takingPart(roster, person) || facts.sent.has(person.id)) {
    return false;
  }
  // Nothing of a team goes out before its own moment, and nothing at all while that isn't planned.
  const from = sendsFrom(plan, person.team);
  if (from === null || now < from) {
    return false;
  }
  const lead = leadOf(roster, person.team);
  if (lead === undefined || lead.id === person.id) {
    return true;
  }
  const leadDone = facts.interviews.get(lead.id)?.completedAt ?? null;
  if (leadDone !== null && facts.mapped.has(person.team)) {
    return true;
  }
  const first = dayOf(from) > plan.start ? dayOf(from) : plan.start;
  return dayOf(now) >= addWorkingDays(first, leadWaitWorkingDays);
};

/** Whose links are due by `now` and not out yet, in the roster's order. */
export const dueLinks = (
  roster: Roster,
  plan: Plan | null,
  facts: LinkFacts,
  now: string
): string[] =>
  plan === null
    ? []
    : roster.people
        .filter((person) => isDue(roster, plan, facts, person, now))
        .map((person) => person.id);

/** How many were asked and talked in a team on one day. */
export interface TeamCount {
  team: string;
  day: string;
  asked: number;
  talked: number;
}

/**
 * Where the interviews stand, as the company's admin may see it: how many
 * were asked and how many talked, never who. The counts are tallies that
 * only grow, kept by the team someone was in when their link went out, so
 * editing the roster afterwards (someone marked away, moved, removed)
 * moves no number. They count only what happened before today, so they
 * move once a day and two looks can't tell who just talked. A team shows
 * its numbers only once `minTeamShown` people in it were asked, and how
 * many talked only once `minTalkedShown` did: the admin controls the list,
 * so made-up people could fill a team up to five asked.
 */
export const progressOf = (
  roster: Roster,
  interviews: ReadonlyMap<string, InterviewState>,
  counts: readonly TeamCount[],
  now: string
): OnboardingProgress => {
  const asOf = dayOf(now);
  const before = counts.filter(({ day }) => day < asOf);
  const tally = (team: string) => {
    const sum = { asked: 0, talked: 0 };
    for (const count of before) {
      if (count.team === team) {
        sum.asked += count.asked;
        sum.talked += count.talked;
      }
    }
    return sum;
  };
  const leadDone = (lead: string | null): boolean => {
    const completed =
      lead === null ? null : (interviews.get(lead)?.completedAt ?? null);
    return completed !== null && dayOf(completed) < asOf;
  };
  const teams = roster.teams.map((team): TeamProgress => {
    const { asked, talked } = tally(team.id);
    const shown = !team.off && asked >= minTeamShown;
    return {
      id: team.id,
      name: team.name,
      people: roster.people.filter((person) => person.team === team.id).length,
      off: team.off,
      leadTalked: leadDone(team.lead),
      talked: shown && talked >= minTalkedShown ? talked : null,
      asked: shown ? asked : null,
    };
  });
  const taking = roster.teams.filter((team) => !team.off && team.lead !== null);
  return {
    teams,
    talked: teams.reduce((sum, team) => sum + (team.talked ?? 0), 0),
    asked: teams.reduce((sum, team) => sum + (team.asked ?? 0), 0),
    leadsTalked: taking.filter((team) => leadDone(team.lead)).length,
    leads: taking.length,
    asOf,
  };
};
