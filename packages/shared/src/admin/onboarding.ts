/**
 * Client onboarding as the admin's model reads it: how much each source adds to what Grasp knows,
 * the threshold Grasp opens at, and how long the listening weeks last.
 */

/** How much each source adds to the brain, in percent. Configurable; together 100. */
export const WEIGHTS = {
  /** The vision call and the website, in before the client signs in. */
  vision: 20,
  directory: 15,
  /** Where the documents live: SharePoint, Google Drive, Teams and the like. */
  sources: 5,
  /** The documents the admin drops in: policies, procedures, handbooks. */
  documents: 5,
  pulse: 5,
  /** The HR platform: who leads which team. */
  leadsKnown: 10,
  /** The share of team leads interviewed. */
  leadsHeard: 15,
  /** The share of everyone else interviewed. */
  everyoneHeard: 15,
  /** Review items settled and baselines confirmed, half each. */
  review: 10,
} as const;

/** Grasp opens at this share of what it needs, unless the client sets another. */
export const DEFAULT_THRESHOLD = 80;

/** One team in the directory, as the sign-in reads it: a name and a head count, never names. */
export interface DirectoryTeam {
  id: string;
  name: string;
  people: number;
  /** The lead's first name, for the one line that suggests a word from them. */
  lead?: string;
}

/** The two weeks the listening weeks were first drawn for: the quiet window scales from them. An organization's own interviews run as long as its plan (`listenDays`). */
export const LISTEN_DAYS = 14;
