import { onboardingPeopleMax, teamNameKey } from "@grasp-os/shared/onboarding";
import type { RosterPerson, RosterTeam } from "@grasp-os/shared/onboarding";
import { z } from "zod";

// Who Stephen talks to, as the admin picks it on the leads step
// (leads-step.tsx): everyone the directory or a staff list gave, each
// ticked to take part or not, and one lead marked per team. Kept as core
// keeps it (a team `off`, a person `away`, a team's `lead`), so nothing
// new goes to core: a person takes part when their team isn't off and
// they aren't away. Pure.

/** The people and their teams, as the step holds them: empty before anyone is in. */
export interface Picks {
  teams: RosterTeam[];
  people: RosterPerson[];
}

export const noPicks: Picks = { teams: [], people: [] };

/** Whether `person` takes part: their team isn't off, and they aren't away. */
export const takesPart = (picks: Picks, person: RosterPerson): boolean =>
  !person.away &&
  picks.teams.some((team) => team.id === person.team && !team.off);

/** Whether `person` leads their team. */
export const leads = (picks: Picks, person: RosterPerson): boolean =>
  picks.teams.some(
    (team) => team.id === person.team && team.lead === person.id
  );

/**
 * `picks` with the people `ids` taking part (`on`) or not. Each team
 * touched is kept as core reads it: off once nobody in it takes part,
 * else on with everyone not taking part away. A lead who no longer
 * takes part leads no more.
 */
export const withTaking = (
  picks: Picks,
  ids: ReadonlySet<string>,
  on: boolean
): Picks => {
  const taking = new Set(
    picks.people
      .filter((person) => (ids.has(person.id) ? on : takesPart(picks, person)))
      .map((person) => person.id)
  );
  const touched = new Set(
    picks.people.filter((person) => ids.has(person.id)).map(({ team }) => team)
  );
  const anyIn = new Set(
    picks.people
      .filter((person) => taking.has(person.id))
      .map(({ team }) => team)
  );
  return {
    teams: picks.teams.map((team) => {
      if (!touched.has(team.id)) {
        return team;
      }
      const lead =
        team.lead !== null && taking.has(team.lead) ? team.lead : null;
      return { ...team, off: !anyIn.has(team.id), lead };
    }),
    people: picks.people.map((person) => {
      if (!touched.has(person.team)) {
        return person;
      }
      // A team switched off keeps no one away: switched on again, all of it is back.
      const away = anyIn.has(person.team) && !taking.has(person.id);
      return person.away === away ? person : { ...person, away };
    }),
  };
};

/**
 * `picks` with `id` leading their team (`on`), or no longer. A team has
 * one lead: marking another moves it. A lead takes part.
 */
export const withLead = (picks: Picks, id: string, on: boolean): Picks => {
  const person = picks.people.find((each) => each.id === id);
  if (person === undefined) {
    return picks;
  }
  const taking = on ? withTaking(picks, new Set([id]), true) : picks;
  return {
    ...taking,
    teams: taking.teams.map((team) => {
      if (team.id !== person.team) {
        return team;
      }
      if (on) {
        return { ...team, lead: id };
      }
      return team.lead === id ? { ...team, lead: null } : team;
    }),
  };
};

/** How many take part, how many lead, and how many there are. */
export const countsOf = (
  picks: Picks
): { taking: number; leads: number; all: number } => {
  const taking = picks.people.filter((person) =>
    takesPart(picks, person)
  ).length;
  const leadIds = new Set(picks.teams.map((team) => team.lead));
  return {
    taking,
    leads: picks.people.filter(
      (person) => leadIds.has(person.id) && takesPart(picks, person)
    ).length,
    all: picks.people.length,
  };
};

/** Whether `person` is found by `query`: by name, address, job or team, any case, any accents. */
const folded = (text: string): string =>
  text.normalize("NFD").replaceAll(/\p{M}/gu, "").toLocaleLowerCase();

/** The people `query` finds, in the order they are in. Every one for an empty query. */
export const found = (picks: Picks, query: string): RosterPerson[] => {
  const words = folded(query).split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return picks.people;
  }
  const teamName = new Map(picks.teams.map((team) => [team.id, team.name]));
  return picks.people.filter((person) => {
    const said = folded(
      [person.name, person.email, person.title, teamName.get(person.team)]
        .filter(Boolean)
        .join(" ")
    );
    return words.every((word) => said.includes(word));
  });
};

/** One team and its people, as the list shows it: largest first, the team for people without one last. */
export interface TeamRows {
  team: RosterTeam;
  people: RosterPerson[];
}

export const teamRowsOf = (
  picks: Picks,
  people: readonly RosterPerson[],
  noTeamId: string,
  /** Who stands first in their team: the leads as the list opened, so marking one moves no row. */
  first: ReadonlySet<string> = new Set(
    picks.teams.flatMap(({ lead }) => (lead === null ? [] : [lead]))
  )
): TeamRows[] => {
  const byTeam = new Map<string, RosterPerson[]>();
  for (const person of people) {
    byTeam.set(person.team, [...(byTeam.get(person.team) ?? []), person]);
  }
  const all = new Map<string, number>();
  for (const person of picks.people) {
    all.set(person.team, (all.get(person.team) ?? 0) + 1);
  }
  return picks.teams
    .filter((team) => byTeam.has(team.id))
    .map((team) => ({
      team,
      // The lead first, then the rest by name.
      people: (byTeam.get(team.id) ?? []).toSorted((a, b) => {
        if (first.has(a.id) !== first.has(b.id)) {
          return first.has(a.id) ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      }),
    }))
    .toSorted((a, b) => {
      if (a.team.id === noTeamId) {
        return 1;
      }
      if (b.team.id === noTeamId) {
        return -1;
      }
      return (all.get(b.team.id) ?? 0) - (all.get(a.team.id) ?? 0);
    });
};

const emailSchema = z.email().max(120);

/** One address the admin typed or pasted, with the name it came with, if any. */
export interface Typed {
  name: string;
  email: string;
}

/** A name made from an address: `anna.de.vries@…` is Anna De Vries. */
export const nameFromEmail = (email: string): string =>
  (email.split("@")[0] ?? "")
    .split(/[._+-]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ")
    .slice(0, 80);

/**
 * The addresses in what the admin pasted: one or many, apart by commas,
 * semicolons, spaces or lines, as a mail program copies them too
 * (`Anna de Vries <anna@acme.nl>`). Each once; what is no address is
 * `wrong`.
 */
export const typedOf = (text: string): { typed: Typed[]; wrong: string[] } => {
  const typed: Typed[] = [];
  const wrong: string[] = [];
  const seen = new Set<string>();
  const parts = text
    .split(/[,;\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const named = /^"?(?<name>[^"<]*?)"?\s*<(?<email>[^>]+)>$/u.exec(part);
    // A part without a name in it may still be several addresses apart by spaces.
    const each =
      named === null
        ? part.split(/\s+/u).map((email) => ({ name: "", email }))
        : [
            {
              name: named.groups?.name?.trim() ?? "",
              email: named.groups?.email?.trim() ?? "",
            },
          ];
    for (const { name, email } of each) {
      const address = email.toLowerCase();
      if (!emailSchema.safeParse(address).success) {
        wrong.push(email);
        continue;
      }
      if (seen.has(address)) {
        continue;
      }
      seen.add(address);
      typed.push({
        name: name === "" ? nameFromEmail(address) : name.slice(0, 80),
        email: address,
      });
    }
  }
  return { typed, wrong };
};

/** Where people added by address go: a team there is, or a new one by its name. */
export type AddTo = { team: string } | { newTeam: string };

/** A free id from `base`: `base`, else `base-2`, `base-3`. */
const freeId = (base: string, taken: ReadonlySet<string>): string => {
  let id = base;
  let next = 2;
  while (taken.has(id)) {
    id = `${base}-${next}`;
    next += 1;
  }
  return id;
};

/** An id core takes: letters, digits, - and _ only, at most 60. */
const slugOf = (text: string): string =>
  folded(text)
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 40) || "team";

/** Why people could not be added: more than an onboarding takes. */
export class TooManyPeopleError extends Error {
  constructor() {
    super("too many people");
    this.name = "TooManyPeopleError";
  }
}

/**
 * `picks` with the people `typed` in, taking part, in team `to`. Someone
 * already in, by address, is ticked to take part where they are, not
 * added twice. A new team named as one there is (any case) is that team.
 */
export const withAdded = (
  picks: Picks,
  typed: readonly Typed[],
  to: AddTo
): { picks: Picks; added: number; there: number } => {
  let { teams } = picks;
  let team = "";
  if ("team" in to) {
    ({ team } = to);
  } else {
    const name = to.newTeam.trim().slice(0, 80);
    const same = teams.find(
      (each) => teamNameKey(each.name) === teamNameKey(name)
    );
    if (same === undefined) {
      team = freeId(`t-${slugOf(name)}`, new Set(teams.map(({ id }) => id)));
      teams = [...teams, { id: team, name, lead: null, does: "", off: false }];
    } else {
      team = same.id;
    }
  }
  const byEmail = new Map(
    picks.people
      .filter((person) => person.email !== "")
      .map((person) => [person.email.toLowerCase(), person.id])
  );
  const taken = new Set(picks.people.map(({ id }) => id));
  const fresh: RosterPerson[] = [];
  const there = new Set<string>();
  for (const { name, email } of typed) {
    const known = byEmail.get(email);
    if (known !== undefined) {
      there.add(known);
      continue;
    }
    const id = freeId(`p-${slugOf(email)}`.slice(0, 60), taken);
    taken.add(id);
    fresh.push({ id, name, email, team, title: "", away: false });
  }
  if (picks.people.length + fresh.length > onboardingPeopleMax) {
    throw new TooManyPeopleError();
  }
  const grown: Picks = { teams, people: [...picks.people, ...fresh] };
  return {
    picks: withTaking(
      grown,
      new Set([...there, ...fresh.map(({ id }) => id)]),
      true
    ),
    added: fresh.length,
    there: there.size,
  };
};
