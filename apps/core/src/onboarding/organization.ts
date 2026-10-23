import { addWorkingDays, dayOf } from "@grasp-os/shared/admin/org-record";
import { leadWaitWorkingDays } from "@grasp-os/shared/onboarding";
import type { Plan, Roster, RosterPerson } from "@grasp-os/shared/onboarding";
import type {
  MemberState,
  OrganizationChange,
  OrganizationPerson,
  OrganizationTeam,
  StaffOrganization,
  TeamFlag,
  TeamTurn,
} from "@grasp-os/shared/onboarding-organization";

import { sendsFrom, takingPart } from "./rules.ts";

// The organization as Grasp's staff see it and put it right (GRA-321), as
// pure functions of what the store holds: the list after one change, and
// every team with its people, its map, when its links go out and what
// needs a look there. Ported from the prototype (grasplabs/prototype,
// packages/grasp: `organizationOf` in src/lib/admin-organization.ts, and
// the changes in src/data/org-structure.ts).

/** A change to the list itself, as `rosterAfter` makes it. */
export type ListChange = Extract<
  OrganizationChange,
  {
    kind:
      | "addTeam"
      | "editTeam"
      | "takesPart"
      | "lead"
      | "addPerson"
      | "editPerson"
      | "away"
      | "removePerson";
  }
>;

/** Why a change to the list can't be made. */
export type ListRefusal =
  | "onboarding.no_team"
  | "onboarding.not_found"
  | "onboarding.team_taken";

/** The same team name, however it's written. */
const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const withTeam = (
  roster: Roster,
  team: string,
  change: (one: Roster["teams"][number]) => Roster["teams"][number]
): Roster | ListRefusal =>
  roster.teams.some(({ id }) => id === team)
    ? {
        ...roster,
        teams: roster.teams.map((one) => (one.id === team ? change(one) : one)),
      }
    : "onboarding.no_team";

const withPerson = (
  roster: Roster,
  person: string,
  change: (one: RosterPerson) => RosterPerson
): Roster | ListRefusal =>
  roster.people.some(({ id }) => id === person)
    ? {
        ...roster,
        people: roster.people.map((one) =>
          one.id === person ? change(one) : one
        ),
      }
    : "onboarding.not_found";

/** Whoever leaves a team, or the list, leads it no longer. */
const unled = (roster: Roster, person: string, stays: string | null) => ({
  ...roster,
  teams: roster.teams.map((team) =>
    team.lead === person && team.id !== stays ? { ...team, lead: null } : team
  ),
});

/**
 * The list after one change; `id` names a team or person it adds. A
 * team's name is its own; someone moved, or taken off, no longer leads
 * the team they were in. The store holds the result to the roster's rules.
 */
export const rosterAfter = (
  roster: Roster,
  change: ListChange,
  id: string
): Roster | ListRefusal => {
  const taken = (name: string, except?: string) =>
    roster.teams.some(
      (team) => team.id !== except && sameName(team.name, name)
    );
  const hasTeam = (team: string) =>
    roster.teams.some(({ id: of }) => of === team);
  switch (change.kind) {
    case "addTeam": {
      if (taken(change.name)) {
        return "onboarding.team_taken";
      }
      const team = {
        id,
        name: change.name,
        lead: null,
        does: change.does,
        off: false,
      };
      return { ...roster, teams: [...roster.teams, team] };
    }
    case "editTeam": {
      if (taken(change.name, change.team)) {
        return "onboarding.team_taken";
      }
      return withTeam(roster, change.team, (team) => ({
        ...team,
        name: change.name,
        does: change.does,
      }));
    }
    case "takesPart": {
      return withTeam(roster, change.team, (team) => ({
        ...team,
        off: !change.takes,
      }));
    }
    case "lead": {
      const { person } = change;
      if (
        person !== null &&
        !roster.people.some(({ id: of }) => of === person)
      ) {
        return "onboarding.not_found";
      }
      return withTeam(roster, change.team, (team) => ({
        ...team,
        lead: person,
      }));
    }
    case "addPerson": {
      if (!hasTeam(change.team)) {
        return "onboarding.no_team";
      }
      const person = {
        id,
        name: change.name,
        email: change.email,
        title: change.title,
        team: change.team,
        away: false,
      };
      return { ...roster, people: [...roster.people, person] };
    }
    case "editPerson": {
      if (!hasTeam(change.team)) {
        return "onboarding.no_team";
      }
      const next = withPerson(roster, change.person, (person) => ({
        ...person,
        name: change.name,
        email: change.email,
        title: change.title,
        team: change.team,
      }));
      return typeof next === "string"
        ? next
        : unled(next, change.person, change.team);
    }
    case "away": {
      return withPerson(roster, change.person, (person) => ({
        ...person,
        away: change.away,
      }));
    }
    case "removePerson": {
      if (!roster.people.some(({ id: of }) => of === change.person)) {
        return "onboarding.not_found";
      }
      return unled(
        {
          ...roster,
          people: roster.people.filter(({ id: of }) => of !== change.person),
        },
        change.person,
        null
      );
    }
    default: {
      return roster;
    }
  }
};

/** What the store holds that the organization is read from. */
export interface OrganizationFacts {
  roster: Roster;
  plan: Plan | null;
  /** Links go out: a plan, the agreements in, not paused. */
  open: boolean;
  links: ReadonlyMap<string, { sentAt: string; openedAt: string | null }>;
  interviews: ReadonlyMap<
    string,
    {
      startedAt: string | null;
      completedAt: string | null;
      agreedAt: string | null;
    }
  >;
  works: readonly {
    id: string;
    team: string;
    name: string;
    local: string;
    share: number;
    doers: readonly string[];
  }[];
  /** The piece of work each person is asked about. */
  asked: ReadonlyMap<string, string>;
  /** Teams whose map was drawn, or given up on. */
  mapped: ReadonlySet<string>;
}

const stateOf = (
  facts: OrganizationFacts,
  person: RosterPerson
): MemberState => {
  const interview = facts.interviews.get(person.id);
  if ((interview?.completedAt ?? null) !== null) {
    return "talked";
  }
  if ((interview?.startedAt ?? null) !== null) {
    return "started";
  }
  if (!takingPart(facts.roster, person)) {
    return person.away ? "away" : "out";
  }
  const link = facts.links.get(person.id);
  if (link === undefined) {
    return "waiting";
  }
  return link.openedAt === null ? "sent" : "opened";
};

/**
 * When a team's links go out. A lead's at the team's moment; everyone
 * else's once the lead has talked and the map is drawn, or
 * `leadWaitWorkingDays` after the team's first day (rules.ts `isDue`).
 */
const turnOf = (
  facts: OrganizationFacts,
  team: Roster["teams"][number],
  now: string
): TeamTurn => {
  const { roster, plan } = facts;
  if (team.off) {
    return { kind: "off" };
  }
  const from = plan === null ? null : sendsFrom(plan, team.id);
  if (plan === null || from === null) {
    return { kind: "unplanned" };
  }
  if (now < from) {
    return { kind: "from", at: from };
  }
  const waiting = roster.people.filter(
    (person) =>
      person.team === team.id &&
      takingPart(roster, person) &&
      !facts.links.has(person.id)
  );
  if (waiting.length === 0) {
    return { kind: "out" };
  }
  const lead = roster.people.find(
    (person) => person.id === team.lead && !person.away
  );
  const talked =
    lead !== undefined &&
    (facts.interviews.get(lead.id)?.completedAt ?? null) !== null &&
    facts.mapped.has(team.id);
  const first = dayOf(from) > plan.start ? dayOf(from) : plan.start;
  const by = addWorkingDays(first, leadWaitWorkingDays);
  const others = waiting.some((person) => person.id !== lead?.id);
  return lead !== undefined && !talked && others && dayOf(now) < by
    ? { kind: "lead", lead: lead.name, by }
    : { kind: "due" };
};

const flagsOf = (
  facts: OrganizationFacts,
  team: OrganizationTeam,
  people: readonly OrganizationPerson[],
  now: string
): TeamFlag[] => {
  if (team.off) {
    return [];
  }
  const members = people.filter((person) => person.team === team.id);
  const flags: TeamFlag[] = [];
  const lead = members.find((person) => person.id === team.lead);
  if (lead === undefined && members.length > 0) {
    flags.push({ kind: "noLead" });
  }
  const sentAt =
    lead === undefined ? undefined : facts.links.get(lead.id)?.sentAt;
  if (
    lead !== undefined &&
    sentAt !== undefined &&
    lead.state !== "talked" &&
    dayOf(now) >= addWorkingDays(sentAt, leadWaitWorkingDays)
  ) {
    flags.push({ kind: "leadLate", lead: lead.name });
  }
  if (
    lead?.state === "talked" &&
    facts.mapped.has(team.id) &&
    team.works.length === 0
  ) {
    flags.push({ kind: "noMap" });
  }
  for (const work of team.works) {
    if (work.doers.length === 0) {
      flags.push({ kind: "nobody", work: work.name });
    }
  }
  const unasked = members.filter(
    (person) => !person.lead && !person.away && person.work === null
  ).length;
  if (team.works.length > 0 && unasked > 0) {
    flags.push({ kind: "unasked", count: unasked });
  }
  return flags;
};

/** The organization as Grasp's staff see it, as of `now`. */
export const organizationOf = (
  facts: OrganizationFacts,
  now: string
): StaffOrganization => {
  const { roster } = facts;
  const leads = new Set(roster.teams.map(({ lead }) => lead));
  const people = roster.people.map((person): OrganizationPerson => ({
    id: person.id,
    name: person.name,
    email: person.email,
    title: person.title,
    team: person.team,
    away: person.away,
    lead: leads.has(person.id),
    state: stateOf(facts, person),
    work: facts.asked.get(person.id) ?? null,
  }));
  // Whoever does a piece of work stays with it on another team, when they
  // talked about it; only who left the list is gone from it.
  const listed = new Set(roster.people.map(({ id }) => id));
  const teams = roster.teams.map((team): OrganizationTeam => {
    const shown: OrganizationTeam = {
      id: team.id,
      name: team.name,
      does: team.does,
      off: team.off,
      lead: team.lead,
      works: facts.works
        .filter((work) => work.team === team.id)
        .map((work) => ({
          id: work.id,
          name: work.name,
          local: work.local,
          share: work.share,
          doers: work.doers.filter((person) => listed.has(person)),
        })),
      drawable:
        team.lead !== null &&
        (facts.interviews.get(team.lead)?.agreedAt ?? null) !== null,
      turn: turnOf(facts, team, now),
      flags: [],
    };
    return { ...shown, flags: flagsOf(facts, shown, people, now) };
  });
  return { teams, people, open: facts.open };
};
