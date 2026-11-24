// The company's teams as every member reads them (GRA-1748): each team on
// the staff list the admin confirmed and that takes part, its name, what
// it does as the admin described it, and how many people the roster has
// in it. Only what the admin gave: never what a lead's map says a team
// does, a model's answer from that lead's own interview (team-map.ts,
// `mappedDoes`), never who is in a team, their names, addresses or titles,
// nor who leads it. The store keeps them as confirmed (onboarding/store.ts
// `#rosterConfirmed`); the Brain page reads them there (brain-rpc.ts), and
// the new Brain holds this text of them as a source readable by everyone
// (onboarding/new-brain.ts `rosterOf`).

/** A team as every member reads it. */
export interface CompanyTeam {
  /** The id the admin gave it. */
  id: string;
  name: string;
  /** What it does, as the admin described it; empty if they didn't. */
  does: string;
  /** How many people the roster has in it: never how many were interviewed. */
  people: number;
}

/**
 * `teams` as the new Brain's source text, for recall: written for a model
 * to read, in English like the rest of Grasp's own words to it. With no
 * team taking part (the admin switched every one off), one fixed
 * sentence says so, so the Brain never keeps listing them.
 */
export const companyTeamsText = (teams: readonly CompanyTeam[]): string =>
  `The company's teams, from its staff list\n\n${
    teams.length === 0
      ? "No team takes part."
      : teams
          .map(({ name, does, people }) => {
            const size = `${people === 1 ? "1 person" : `${people} people`}.`;
            return does.trim() === ""
              ? `- ${name}: ${size}`
              : `- ${name}: ${size} ${does.trim()}`;
          })
          .join("\n")
  }`;
