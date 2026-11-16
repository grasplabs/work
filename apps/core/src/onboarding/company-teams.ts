// The company's teams as every member reads them (GRA-1748): each team on
// the staff list the admin gave, with what it does and how many people it
// has. Never who is in it, their names, addresses or titles, nor who leads
// it: those stay the admin's, in the onboarding's store. The store keeps
// the list (onboarding/store.ts `companyTeams`); the Brain page reads it
// there (brain-rpc.ts), and the new Brain holds this text of it as a
// source readable by everyone (onboarding/new-brain.ts `rosterOf`).

/** A team as every member reads it. */
export interface CompanyTeam {
  /** The id the admin gave it. */
  id: string;
  name: string;
  /** What it does, as the admin or its lead's map said; empty if neither did. */
  does: string;
  /** How many people the staff list has in it. */
  people: number;
}

/**
 * `teams` as the new Brain's source text, for recall: written for a model
 * to read, in English like the rest of Grasp's own words to it. With no
 * team, it says so: a version of its own, as an empty vision's is.
 */
export const companyTeamsText = (teams: readonly CompanyTeam[]): string =>
  `The company's teams, from its staff list\n\n${
    teams.length === 0
      ? "The staff list has no teams."
      : teams
          .map(({ name, does, people }) => {
            const size = people === 1 ? "1 person" : `${people} people`;
            return does.trim() === ""
              ? `- ${name}: ${size}.`
              : `- ${name}: ${size}. ${does.trim()}`;
          })
          .join("\n")
  }`;
