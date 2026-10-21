/**
 * The demo company the seed fills the local stack with: the prototype's
 * Noordkade Finance (grasplabs/prototype,
 * `packages/grasp/src/data/noordkade.ts`), a mortgage and lending adviser
 * with six teams. Its members are the prototype's, with the roles core
 * has; everyone else in its team directory is on the onboarding's roster
 * only. Everyone is at acme.test, the domain the local stack signs people
 * in from (apps/core/test/sign-in-config.ts), and every name is made up.
 */
import type { RosterInput } from "@grasp-os/shared/onboarding";
import type { Role } from "@grasp-os/shared/roles";

import { localAdmin } from "../../apps/core/test/sign-in-config.ts";

/** The company's name, as its brain and settings show it. */
export const companyName = "Noordkade Finance";

export const teamNames = [
  "Client onboarding",
  "Mortgage advice",
  "Customer service",
  "Finance",
  "Compliance",
  "Operations",
] as const;

export type TeamName = (typeof teamNames)[number];

export interface Person {
  /** Who they are in the seed's own data: what runs and chats name. */
  key: string;
  email: string;
  name: string;
  /**
   * The prototype's roles in core's: an owner is an admin, an admin who
   * makes workflows and apps a builder, a viewer a user.
   */
  role: Role;
  teams: TeamName[];
  /** How long ago they joined, in days: their first sign-in, backdated. */
  joinedDaysAgo: number;
}

/**
 * Who works with Grasp: the prototype's members, but Ruben Altena, who is
 * Grasp's staff, not the company's. The configured admin of the local
 * stack, whom a developer signs in as, is the COO. Lisa de Vries is a
 * viewer in the prototype, but she owns the service desk's domain, which
 * takes a builder in core. Jeroen Mulder, the finance assistant the
 * prototype's finance cockpit names, signs in too: he puts the supplier
 * invoices in, since core lets nobody decide on a run they started.
 */
export const people = [
  {
    key: "sanne",
    email: localAdmin,
    name: "Sanne de Wit",
    role: "admin",
    teams: [],
    joinedDaysAgo: 58,
  },
  {
    key: "daan",
    email: "daan.kuiper@acme.test",
    name: "Daan Kuiper",
    role: "admin",
    teams: [],
    joinedDaysAgo: 58,
  },
  {
    key: "pieter",
    email: "pieter.deboer@acme.test",
    name: "Pieter de Boer",
    role: "admin",
    teams: [],
    joinedDaysAgo: 57,
  },
  {
    key: "eva",
    email: "eva.bakker@acme.test",
    name: "Eva Bakker",
    role: "builder",
    teams: ["Finance"],
    joinedDaysAgo: 52,
  },
  {
    key: "jeroen",
    email: "jeroen.mulder@acme.test",
    name: "Jeroen Mulder",
    role: "user",
    teams: ["Finance"],
    joinedDaysAgo: 44,
  },
  {
    key: "nina",
    email: "nina.visser@acme.test",
    name: "Nina Visser",
    role: "builder",
    teams: ["Client onboarding"],
    joinedDaysAgo: 51,
  },
  {
    key: "mark",
    email: "mark.jansen@acme.test",
    name: "Mark Jansen",
    role: "builder",
    teams: ["Mortgage advice"],
    joinedDaysAgo: 49,
  },
  {
    key: "lisa",
    email: "lisa.devries@acme.test",
    name: "Lisa de Vries",
    role: "builder",
    teams: ["Customer service"],
    joinedDaysAgo: 47,
  },
  {
    key: "joost",
    email: "joost.smit@acme.test",
    name: "Joost Smit",
    role: "user",
    teams: ["Compliance"],
    joinedDaysAgo: 45,
  },
] as const satisfies Person[];

export type PersonKey = (typeof people)[number]["key"];

/**
 * The team directory, as the prototype counts it (`teams` in
 * noordkade.ts): each team's jobs and how many hold each, the first its
 * lead. The people the prototype names fill their jobs first, by key for
 * members; the rest get names of their own.
 */
const directory: {
  id: string;
  name: TeamName;
  /** `named`: members by their key, anyone else by name. */
  jobs: { title: string; count: number; named?: string[] }[];
}[] = [
  {
    id: "team-onboarding",
    name: "Client onboarding",
    jobs: [
      { title: "Head of client onboarding", count: 1, named: ["nina"] },
      { title: "Intake desk", count: 1, named: ["Tom Hendriks"] },
      { title: "Onboarding advisor", count: 4 },
    ],
  },
  {
    id: "team-mortgage",
    name: "Mortgage advice",
    jobs: [
      { title: "Team lead mortgage advice", count: 1, named: ["mark"] },
      { title: "Senior advisor", count: 5 },
      { title: "Mortgage advisor", count: 12, named: ["Fatima El Amrani"] },
    ],
  },
  {
    id: "team-service",
    name: "Customer service",
    jobs: [
      { title: "Head of customer service", count: 1, named: ["lisa"] },
      { title: "Service desk", count: 14, named: ["Bram Peeters"] },
    ],
  },
  {
    id: "team-finance",
    name: "Finance",
    jobs: [
      { title: "Controller", count: 1, named: ["eva"] },
      { title: "CFO", count: 1 },
      { title: "Finance assistant", count: 6, named: ["jeroen"] },
    ],
  },
  {
    id: "team-compliance",
    name: "Compliance",
    jobs: [
      { title: "Head of compliance", count: 1, named: ["joost"] },
      { title: "Compliance officer", count: 4, named: ["Anouk Vermeer"] },
    ],
  },
  {
    id: "team-operations",
    name: "Operations",
    jobs: [
      { title: "Head of operations", count: 1 },
      { title: "Operations assistant", count: 8 },
    ],
  },
];

const firstNames = [
  "Sophie",
  "Lars",
  "Emma",
  "Bas",
  "Julia",
  "Thijs",
  "Lotte",
  "Pim",
  "Femke",
  "Koen",
  "Iris",
  "Stijn",
  "Noor",
  "Wouter",
  "Sara",
  "Jesse",
  "Maaike",
  "Daniël",
  "Eline",
  "Youssef",
  "Roos",
  "Milan",
  "Hanna",
] as const;

const lastNames = [
  "van Dijk",
  "Meijer",
  "de Groot",
  "Bos",
  "Vos",
  "Peters",
  "Kok",
  "Jacobs",
  "van den Berg",
  "Dekker",
  "Brouwer",
  "de Haan",
  "Koster",
  "Prins",
  "Verhoeven",
  "Postma",
  "Schouten",
  "Kuipers",
  "Willems",
] as const;

/** Letters, digits and dashes: a roster ID, or an email's local part. */
const slugOf = (name: string): string =>
  name
    .normalize("NFD")
    .replaceAll(/[^A-Za-z0-9 ]/gu, "")
    .trim()
    .toLowerCase()
    .replaceAll(/ +/gu, "-");

/**
 * Who works where, for the onboarding: every team in the directory with
 * its lead, and everyone in it, members by their own name and email.
 * Who is in no team, as the COO, the CEO and IT, isn't on it.
 */
export const roster = (): RosterInput => {
  const byKey = new Map<string, Person>(
    people.map((person) => [person.key, person])
  );
  let made = 0;
  /** A name of their own: first and last names paired so none repeats. */
  const madeUpName = (): string => {
    const first = firstNames[made % firstNames.length] ?? "";
    const last = lastNames[made % lastNames.length] ?? "";
    made += 1;
    return `${first} ${last}`;
  };
  const teams: RosterInput["teams"] = [];
  const members: RosterInput["people"] = [];
  for (const team of directory) {
    let lead: string | null = null;
    for (const { title, count, named = [] } of team.jobs) {
      for (let index = 0; index < count; index += 1) {
        const given = named[index];
        const member = given === undefined ? undefined : byKey.get(given);
        const name = member?.name ?? given ?? madeUpName();
        const id = slugOf(name);
        members.push({
          id,
          name,
          email:
            member?.email ?? `${slugOf(name).replaceAll("-", ".")}@acme.test`,
          team: team.id,
          title,
        });
        lead ??= id;
      }
    }
    teams.push({ id: team.id, name: team.name, lead });
  }
  return { teams, people: members };
};
