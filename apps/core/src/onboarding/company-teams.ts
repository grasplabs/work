// The company's teams as the new Brain is given them (GRA-1748): each team
// on the staff list the admin confirmed and that takes part, with how many
// people it has. Only what the admin gave: never what a team does, which a
// lead's map writes from their own interview (team-map.ts), never who is
// in a team, their names, addresses or titles, nor who leads it. The store
// keeps the list and decides what is given (onboarding/store.ts
// `#confirmedTeams`); the new Brain holds this text of it as a source for
// the company's admins, who read the staff list already
// (onboarding/new-brain.ts `rosterOf`).

/** A team as the new Brain is given it. */
export interface CompanyTeam {
  /** The id the admin gave it. */
  id: string;
  name: string;
  /** How many people the staff list has in it. */
  people: number;
}

/**
 * `teams` as the new Brain's source text, for recall: written for a model
 * to read, in English like the rest of Grasp's own words to it. Never
 * empty: the store gives none before the admin confirmed a team.
 */
export const companyTeamsText = (teams: readonly CompanyTeam[]): string =>
  `The company's teams, from its staff list\n\n${teams
    .map(
      ({ name, people }) =>
        `- ${name}: ${people === 1 ? "1 person" : `${people} people`}.`
    )
    .join("\n")}`;
