import { leadWaitWorkingDays, minTeamShown } from "@grasp-os/shared/onboarding";
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

/**
 * Where the interviews stand, as the company's admin may see it: how many
 * talked, never who; numbers only for teams of `minTeamShown` or more; and
 * only interviews agreed to before today, so the numbers move once a day
 * and two looks can't tell who just talked.
 */
export const progressOf = (
  roster: Roster,
  interviews: ReadonlyMap<string, InterviewState>,
  now: string
): OnboardingProgress => {
  const asOf = dayOf(now);
  const done = (person: string | null): boolean => {
    const completed =
      person === null ? null : (interviews.get(person)?.completedAt ?? null);
    return completed !== null && dayOf(completed) < asOf;
  };
  const shownTeams = new Set<string>();
  const teams = roster.teams.map((team): TeamProgress => {
    const members = roster.people.filter((person) => person.team === team.id);
    const asked = members.filter(
      (person) => !person.away && person.id !== team.lead
    );
    const shown = members.length >= minTeamShown && !team.off;
    if (shown) {
      shownTeams.add(team.id);
    }
    return {
      id: team.id,
      name: team.name,
      people: members.length,
      off: team.off,
      leadTalked: done(team.lead),
      talked: shown ? asked.filter((person) => done(person.id)).length : null,
      asked: shown ? asked.length : null,
    };
  });
  const askedAll = roster.people.filter(
    (person) =>
      shownTeams.has(person.team) &&
      takingPart(roster, person) &&
      !leads(roster, person.id)
  );
  const taking = roster.teams.filter((team) => !team.off && team.lead !== null);
  return {
    teams,
    talked: askedAll.filter((person) => done(person.id)).length,
    asked: askedAll.length,
    leadsTalked: taking.filter((team) => done(team.lead)).length,
    leads: taking.length,
    asOf,
  };
};
