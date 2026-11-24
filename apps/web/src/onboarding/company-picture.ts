// Concepts only: what the company step's two pictures of the roster
// share. Who is in which team, in the roster's own order, and the few
// people the step's words name, so the drawing can light them.
import type { Roster, RosterPerson } from "@grasp-os/shared/onboarding";
import { useLocation } from "@tanstack/react-router";

/** How many of the people the step names, so the admin sees it is their own company. */
const namedMost = 3;

/** The first few people on the list who have a name; someone core erased has none. */
export const namedOf = (roster: Roster): RosterPerson[] =>
  roster.people.filter(({ name }) => name !== "").slice(0, namedMost);

/** A team with its people, in the roster's order, and its lead's name when it has one. */
export interface TeamPicture {
  id: string;
  name: string;
  people: RosterPerson[];
  lead: string | null;
}

export const teamsOf = (roster: Roster): TeamPicture[] =>
  roster.teams.map((team) => {
    const people = roster.people.filter((person) => person.team === team.id);
    const lead = people.find((person) => person.id === team.lead)?.name ?? "";
    return {
      id: team.id,
      name: team.name,
      people,
      lead: lead === "" ? null : lead,
    };
  });

/** Which concept of the step to show, from `?concept=a|b`; none shows today's. */
export type CompanyConcept = "a" | "b";

/**
 * The concept asked for in the address. The setup's own search keeps only
 * what it knows, so this reads the address as it was written.
 */
export const useCompanyConcept = (): CompanyConcept | null => {
  const written = useLocation({ select: (location) => location.searchStr });
  const concept = new URLSearchParams(written).get("concept");
  return concept === "a" || concept === "b" ? concept : null;
};
