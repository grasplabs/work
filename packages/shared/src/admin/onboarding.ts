/**
 * Client onboarding as the admin's model reads it: how much each source adds to what Grasp knows,
 * the threshold Grasp opens at, how long the listening weeks last, and the sample client's
 * directory played day by day. The rest of the prototype's onboarding.ts drew the client's own
 * wizard and stayed behind.
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
  /** How readily the team talks to us, 0 to 1. A quiet team lags. */
  pace: number;
  /** The lead's first name, for the one line that suggests a word from them. */
  lead?: string;
}

/** The people in the vision call, on the board: they talked to us before anyone signed in. */
export const VISION_PEOPLE = 3;

/** The listening weeks, simulated: how far every team is at `progress`. */
export interface Listening {
  /** How far the weeks are, 0 to 1. */
  progress: number;
  /** Day of the fourteen. */
  day: number;
  leadsHeard: number;
  colleaguesHeard: number;
  /** Per directory team, in order: people who talked to us, the vision call included. */
  heard: number[];
  leadHeard: boolean[];
  workflows: number;
  /** Baselines an agent had confirmed by the person who knows the work best. */
  baselines: number;
}

export const LISTEN_DAYS = 14;
const LAST_DAY = 12;
export const WORKFLOWS_FOUND = 12;

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(Math.max(value, min), max);
const smooth = (edge0: number, edge1: number, value: number) => {
  const x = clamp((value - edge0) / (edge1 - edge0));
  return x * x * (3 - 2 * x);
};

/**
 * Where the listening weeks are at `progress`, 0 to 1. Leads go first, the quiet team last;
 * everyone else follows their own lead, each team at its own pace.
 */
export const listeningAt = (
  progress: number,
  teams: DirectoryTeam[]
): Listening => {
  const p = clamp(progress);
  const leadAt = teams.map(
    (team, index) => 0.05 + index * 0.025 + (team.pace < 0.4 ? 0.28 : 0)
  );
  const leadHeard = leadAt.map((at) => p > 0 && p >= at);
  const others = teams.map((team, index) =>
    Math.round(
      (team.people - 1) * team.pace * smooth((leadAt[index] ?? 0) + 0.04, 1, p)
    )
  );
  const heard = teams.map((team, index) => {
    const listened = (leadHeard[index] === true ? 1 : 0) + (others[index] ?? 0);
    // The vision call was with the board, before the weeks began.
    return team.id === "board" ? Math.max(listened, VISION_PEOPLE) : listened;
  });
  return {
    progress: p,
    day: p === 0 ? 0 : 1 + Math.floor(p * (LAST_DAY - 1)),
    leadsHeard: leadHeard.filter(Boolean).length,
    colleaguesHeard: others.reduce((sum, count) => sum + count, 0),
    heard,
    leadHeard,
    workflows: Math.round(WORKFLOWS_FOUND * smooth(0.1, 1, p)),
    baselines: Math.round(WORKFLOWS_FOUND * smooth(0.3, 1, p)),
  };
};
