import type { Team, Tool } from "@grasp-os/shared/brain";
import type { AppRequest } from "@grasp-os/shared/connect";
import type { OAuthProvider } from "@grasp-os/shared/connect-names";

import { beyond, plain } from "./integrations.ts";
import type { Integration } from "./integrations.ts";

// Recommended, on the Integrations overview: the apps to connect first,
// each with the one reason it is there, only from what Grasp already
// knows. The suite the kickoff says the company works in, the tools the
// company's documents name (with the teams they are about), and the apps
// people asked for. Interviews and what a connected suite sees give no
// reason yet: core links neither to an app. Only an app
// the company could connect and has no connection to is recommended
// (`beyond`), and a name matches an app's only letter for letter.

/** Why an app is recommended. */
export type Reason =
  | { kind: "suite"; suite: OAuthProvider }
  | { kind: "documents"; teams: string[] }
  | { kind: "asked"; people: number };

export interface Recommendation {
  integration: Integration;
  reason: Reason;
}

/** What the reasons are read from. */
export interface Known {
  suites: readonly OAuthProvider[];
  tools: readonly Pick<Tool, "name" | "teamIds">[];
  teams: readonly Pick<Team, "id" | "name">[];
  requests: readonly Pick<AppRequest, "name" | "requestedBy">[];
}

export const nothingKnown: Known = {
  suites: [],
  tools: [],
  teams: [],
  requests: [],
};

/** Most apps recommended at once: two rows of tiles on a wide screen. */
const recommendedAtMost = 6;

/**
 * The apps to connect first, the suite first, then those the most teams'
 * documents name, then those the most people asked for; each app once,
 * for its first reason.
 */
export const recommendedOf = (
  integrations: readonly Integration[],
  { suites, tools, teams, requests }: Known
): Recommendation[] => {
  const open = beyond(integrations);
  const named = (name: string): Integration | undefined =>
    open.find((integration) => plain(integration.name) === plain(name));
  const found = new Map<string, Recommendation>();
  const add = (integration: Integration | undefined, reason: Reason) => {
    if (integration !== undefined && !found.has(integration.key)) {
      found.set(integration.key, { integration, reason });
    }
  };
  for (const suite of suites) {
    add(
      open.find(
        (integration) =>
          integration.source === "native" && integration.id === suite
      ),
      { kind: "suite", suite }
    );
  }
  const teamNames = new Map(teams.map(({ id, name }) => [id, name]));
  const inDocuments = tools
    .map(({ name, teamIds }) => ({
      integration: named(name),
      teams: [
        ...new Set(teamIds.flatMap((id) => teamNames.get(id) ?? [])),
      ].toSorted((one, other) => one.localeCompare(other)),
    }))
    .toSorted((one, other) => other.teams.length - one.teams.length);
  for (const { integration, teams: about } of inDocuments) {
    add(integration, { kind: "documents", teams: about });
  }
  const askers = new Map<
    string,
    { integration: Integration; people: Set<string> }
  >();
  for (const { name, requestedBy } of requests) {
    const integration = named(name);
    if (integration === undefined) {
      continue;
    }
    const asked = askers.get(integration.key) ?? {
      integration,
      people: new Set<string>(),
    };
    asked.people.add(requestedBy.userId);
    askers.set(integration.key, asked);
  }
  for (const { integration, people } of [...askers.values()].toSorted(
    (one, other) => other.people.size - one.people.size
  )) {
    add(integration, { kind: "asked", people: people.size });
  }
  return [...found.values()].slice(0, recommendedAtMost);
};
