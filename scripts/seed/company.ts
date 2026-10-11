/**
 * The demo company the seed fills the local stack with, after the
 * prototype's Noordkade Finance (grasplabs/prototype,
 * `packages/grasp/src/data/noordkade.ts`): a mortgage and lending adviser
 * with five teams. Everyone is at acme.test, the domain the local stack
 * signs people in from (apps/core/test/sign-in-config.ts), and every name
 * is made up.
 */
import type { Role } from "@grasp-os/shared/roles";

import { localAdmin } from "../../apps/core/test/sign-in-config.ts";

export const teamNames = [
  "Client onboarding",
  "Mortgage advice",
  "Customer service",
  "Finance",
  "Compliance",
] as const;

export type TeamName = (typeof teamNames)[number];

export interface Person {
  /** Who they are in the seed's own data: what runs and chats name. */
  key: string;
  email: string;
  name: string;
  role: Role;
  teams: TeamName[];
  /** How long ago they joined, in days: their first sign-in, backdated. */
  joinedDaysAgo: number;
}

/**
 * Who works there. The configured admin of the local stack, whom a
 * developer signs in as, is the COO.
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
    key: "pieter",
    email: "pieter.deboer@acme.test",
    name: "Pieter de Boer",
    role: "admin",
    teams: ["Compliance"],
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
    key: "tom",
    email: "tom.hendriks@acme.test",
    name: "Tom Hendriks",
    role: "user",
    teams: ["Client onboarding"],
    joinedDaysAgo: 40,
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
    key: "fatima",
    email: "fatima.elamrani@acme.test",
    name: "Fatima El Amrani",
    role: "user",
    teams: ["Mortgage advice"],
    joinedDaysAgo: 38,
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
    key: "bram",
    email: "bram.peeters@acme.test",
    name: "Bram Peeters",
    role: "user",
    teams: ["Customer service"],
    joinedDaysAgo: 33,
  },
  {
    key: "joost",
    email: "joost.smit@acme.test",
    name: "Joost Smit",
    role: "user",
    teams: ["Compliance"],
    joinedDaysAgo: 45,
  },
  {
    key: "anouk",
    email: "anouk.vermeer@acme.test",
    name: "Anouk Vermeer",
    role: "user",
    teams: ["Compliance", "Customer service"],
    joinedDaysAgo: 21,
  },
] as const satisfies Person[];

export type PersonKey = (typeof people)[number]["key"];
