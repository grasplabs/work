import type {
  BrainApi,
  BrainChangePage,
  Company,
  Connection,
  Source,
  Stakeholder,
  Team,
  TeamCount,
  Vision,
  Workspace,
} from "@grasp-os/shared/brain";
import type { CatalogSource } from "@grasp-os/shared/connect";
import type { KickoffView } from "@grasp-os/shared/kickoff";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "./auth/auth.ts";
import { brainChanges } from "./brain-changes.ts";
import type { SourceChange } from "./brain-changes.ts";
import { catalogEntries, personOf } from "./connections.ts";
import { organizations } from "./db/core/schema.ts";
import { onboardingStore } from "./onboarding/store.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The company brain's workspace (`brain.read`), assembled from what core
// already holds, each part as the person may read it, so the brain shows
// no one more than the reads it is built from would:
//
// | Workspace          | From                                                     |
// | ------------------ | -------------------------------------------------------- |
// | company            | the organization's name; the kickoff's `business` and    |
// |                    | the roster's head count for admins                       |
// | vision             | the kickoff (`goals`, `pain`) and the roster's teams     |
// |                    | taking part, for admins                                  |
// | teams              | the roster and the kickoff's teams (admins)              |
// | sources            | the kickoff and the roster (admins)                      |
// | connections        | the catalog's offered entries and the person's           |
// |                    | connections                                              |
// | goals, tools,      | nothing core can read holds them yet: empty              |
// | statements,        |                                                          |
// | workflows,         |                                                          |
// | candidates, gaps,  |                                                          |
// | landscape,         |                                                          |
// | policies           |                                                          |
//
// The onboarding (who works where, the kickoff) is the admin's: its own
// RPC shows the roster to admins alone, and the kickoff to Grasp's staff,
// who are admins. The kickoff is the company's sponsor speaking for the
// company, so its reading reaches the company's admins here too, never its
// transcript. Everyone else gets the brain without them. No
// interview's words reach the brain: the onboarding keeps them for staff
// alone, so sources carry no transcript.
//
// The Intake's statements and sources and the workflow map's workflows
// are in each App's own store, which only its builders reach, since
// Knowledge stopped keeping App records (#716). Until core has a read of
// them the brain may make for a person, they stay out.

/** The kickoff, as the source the vision was set in. */
const kickoffSourceId = "src-kickoff";
/** Who works where, as the admin gave it: the source of the teams' sizes. */
const rosterSourceId = "src-roster";

/**
 * Ids by where they come from. A roster team keeps its own id (letters,
 * digits, - and _), so the others take a `.` it can't have, and never
 * meet one of its.
 */
const ids = {
  rosterTeam: (id: string) => `team-${id}`,
  kickoffTeam: (position: number) => `team.kickoff-${position}`,
};

/** The day of an ISO 8601 moment: `YYYY-MM-DD`. */
const dayOf = (iso: string): string => iso.slice(0, 10);

/** A team's name as two sources can both mean it: trimmed, any case. */
const nameKey = (name: string): string => name.trim().toLowerCase();

/** What the onboarding gives the brain, for an admin; nothing for anyone else. */
interface OnboardingFacts {
  view: OnboardingView;
  kickoff: KickoffView;
  rosterSavedAt: string | null;
  sentLinks: { person: string; sentAt: string }[];
}

const onboardingFacts = async (
  env: Env,
  person: Identity
): Promise<OnboardingFacts | null> => {
  if (!isAdmin(person.role)) {
    return null;
  }
  const store = onboardingStore(env);
  const [view, kickoff, rosterSavedAt, sentLinks] = await Promise.all([
    store.view(),
    store.kickoff(),
    store.rosterSavedAt(),
    store.sentLinks(),
  ]);
  return { view, kickoff, rosterSavedAt, sentLinks };
};

/** What the kickoff said about `field` and what the sponsor answered, each on its own line; empty if neither. */
const kickoffSaid = (
  kickoff: KickoffView,
  field: "business" | "goals" | "pain"
): string =>
  [kickoff.reading?.fields[field]?.text, kickoff.answers[field]]
    .map((each) => each?.trim() ?? "")
    .filter((each) => each !== "")
    .join("\n");

/**
 * The onboarding's sources, each with when it came in: the kickoff when
 * its transcript did, and who works where when the admin last saved it.
 * The one definition of which there are and what they are called, for
 * `brain.read` (`onboardingSources`) and `brain.changes` (`sourceChanges`)
 * alike; none for anyone but an admin, who alone has `facts`.
 */
const onboardingSourcesAt = (
  facts: OnboardingFacts | null
): { source: Source; at: string }[] => {
  const kickoffAt = facts?.kickoff.transcript?.at;
  return [
    ...(kickoffAt === undefined
      ? []
      : [
          {
            source: {
              id: kickoffSourceId,
              kind: "interview",
              title: "Kickoff",
              date: dayOf(kickoffAt),
              step: 1,
            } satisfies Source,
            at: kickoffAt,
          },
        ]),
    // The roster is the list of who works where the admin gave: as the
    // brain reads a directory, the source of the teams' sizes and roles.
    ...(facts === null ||
    facts.view.roster === null ||
    facts.rosterSavedAt === null
      ? []
      : [
          {
            source: {
              id: rosterSourceId,
              kind: "import",
              connection: "directory",
              title: "Staff list",
              date: dayOf(facts.rosterSavedAt),
              step: 2,
            } satisfies Source,
            at: facts.rosterSavedAt,
          },
        ]),
  ];
};

/** The onboarding's sources: the kickoff, and who works where. */
const onboardingSources = (facts: OnboardingFacts | null): Source[] =>
  onboardingSourcesAt(facts).map(({ source }) => source);

/** The onboarding's sources as changes (brain-changes.ts), as `brain.read` names them. */
const sourceChanges = (facts: OnboardingFacts | null): SourceChange[] =>
  onboardingSourcesAt(facts).map(({ source, at }) => ({
    id: source.id,
    title: source.title,
    at,
  }));

/**
 * The roster's and the kickoff's teams, one per name: a kickoff team the
 * roster has too is the roster's, found first in the kickoff. Each roster
 * team's size is its people, its roles their titles counted (how many,
 * never who), and its stakeholder its lead, as their title.
 */
const onboardingTeams = (facts: OnboardingFacts | null): Team[] => {
  if (facts === null) {
    return [];
  }
  const { view, kickoff, rosterSavedAt, sentLinks } = facts;
  const kickoffDay =
    kickoff.transcript === null ? null : dayOf(kickoff.transcript.at);
  const kickoffTeams = kickoff.reading?.teams ?? [];
  const fromKickoff = new Map(
    kickoffTeams.map((team, position) => [
      nameKey(team.name),
      { team, position },
    ])
  );
  const kickoffCount = (people: number | undefined): TeamCount[] =>
    kickoffDay === null || people === undefined
      ? []
      : [{ sourceId: kickoffSourceId, date: kickoffDay, people }];
  const roster = view.roster ?? { teams: [], people: [] };
  const rosterDay = rosterSavedAt === null ? null : dayOf(rosterSavedAt);
  const sentAt = new Map(
    sentLinks.map(({ person, sentAt: at }) => [person, at])
  );
  const rosterTeams = roster.teams.map((team): Team => {
    const members = roster.people.filter(({ team: id }) => id === team.id);
    const titles = new Map<string, number>();
    for (const { title } of members) {
      if (title !== "") {
        titles.set(title, (titles.get(title) ?? 0) + 1);
      }
    }
    const said = fromKickoff.get(nameKey(team.name));
    const lead = members.find(({ id }) => id === team.lead);
    const invitedAt = lead === undefined ? undefined : sentAt.get(lead.id);
    const stakeholders: Stakeholder[] =
      lead === undefined || rosterDay === null
        ? []
        : [
            {
              // A role, never the lead's name.
              role: lead.title === "" ? "Team lead" : lead.title,
              sourceId: rosterSourceId,
              date: rosterDay,
              ...(invitedAt === undefined
                ? {}
                : { invitedAt: dayOf(invitedAt) }),
            },
          ];
    return {
      id: ids.rosterTeam(team.id),
      name: team.name,
      sourceId: said === undefined ? rosterSourceId : kickoffSourceId,
      counts: [
        ...kickoffCount(said?.team.people),
        ...(rosterDay === null
          ? []
          : [
              {
                sourceId: rosterSourceId,
                date: rosterDay,
                people: members.length,
                roles: [...titles].map(([name, people]) => ({
                  name,
                  people,
                })),
              },
            ]),
      ],
      stakeholders,
    };
  });
  const inRoster = new Set(roster.teams.map(({ name }) => nameKey(name)));
  const onlyKickoff = [...fromKickoff.values()]
    .filter(({ team }) => !inRoster.has(nameKey(team.name)))
    .map(({ team, position }): Team => ({
      id: ids.kickoffTeam(position),
      name: team.name,
      sourceId: kickoffSourceId,
      counts: kickoffCount(team.people),
      stakeholders: [],
    }));
  return [...rosterTeams, ...onlyKickoff];
};

/** The vision page from the kickoff: empty, but for its teams, until one is in. */
const visionOf = (facts: OnboardingFacts | null): Vision => {
  const kickoff = facts?.kickoff;
  const known =
    kickoff?.transcript !== undefined && kickoff.transcript !== null;
  return {
    // The kickoff's goals are "the goals for the next one to two years,
    // and why AI now"; its pain, "the work the sponsor already suspects
    // costs too much time", is why now.
    ambition: kickoff === undefined ? "" : kickoffSaid(kickoff, "goals"),
    whyNow: kickoff === undefined ? "" : kickoffSaid(kickoff, "pain"),
    // The teams the interviews go to: every roster team taking part.
    inviteTeamIds: (facts?.view.roster?.teams ?? [])
      .filter(({ off }) => !off)
      .map(({ id }) => ids.rosterTeam(id)),
    // Nothing asks the board for a budget or who approves tools yet.
    budget: [],
    toolApproval: [],
    sourceId: known ? kickoffSourceId : "",
    // Nobody confirms a vision page yet: the kickoff's reading is its
    // only version.
    version: known ? 1 : 0,
  };
};

/** The organization's name, as its row has it. */
const organizationName = async (env: Env): Promise<string> => {
  const row = await drizzle(env.DB)
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get();
  return row?.name ?? "";
};

/** A catalog entry's key: its source and id. */
const entryKey = (source: CatalogSource, id: string): string =>
  `${source}:${id}`;

/** How Grasp connects to an entry: a native provider directly. */
const viaOf = (source: string): Connection["via"] =>
  source === "native" ? "direct" : "composio";

/**
 * The catalog's offered entries, each connected when the person has an
 * active connection to it (their own, or a shared one), and the active
 * connections to entries an admin hid or the catalog doesn't list (a toolkit it no longer
 * lists, say). A native provider is connected directly; a toolkit through
 * Composio. A connection matches the tool names that are its name.
 */
const connectionsOf = async (
  env: Env,
  person: Identity
): Promise<Connection[]> => {
  const [entries, listed] = await Promise.all([
    catalogEntries(env),
    personOf(env, person).then(
      async (connecting) => await env.CONNECT.listConnections(connecting)
    ),
  ]);
  const active = new Set(
    listed
      .filter(({ status }) => status === "active")
      .map(({ source, provider }) => entryKey(source, provider))
  );
  // A hidden entry isn't offered, but a connection to it still runs:
  // it stays, by its catalog name.
  const shown = entries.filter(
    ({ source, id, hidden }) => !hidden || active.has(entryKey(source, id))
  );
  const offered = shown.map(({ source, id, name }): Connection => ({
    name,
    status: active.has(entryKey(source, id)) ? "connected" : "available",
    via: viaOf(source),
    matches: [name],
  }));
  const listedKeys = new Set(
    entries.map(({ source, id }) => entryKey(source, id))
  );
  const unlisted = [...active]
    .filter((each) => !listedKeys.has(each))
    .map((each): Connection => {
      const [source = "native", provider = each] = each.split(":");
      return {
        name: provider,
        status: "connected",
        via: viaOf(source),
        matches: [provider],
      };
    });
  return [...offered, ...unlisted];
};

/** The brain's workspace, as `person` may read it. */
export const readBrain = async (
  env: Env,
  person: Identity
): Promise<Workspace> => {
  const [facts, name, connections] = await Promise.all([
    onboardingFacts(env, person),
    organizationName(env),
    connectionsOf(env, person),
  ]);

  const company: Company = {
    name,
    sector: facts === null ? "" : kickoffSaid(facts.kickoff, "business"),
    people: facts?.view.roster?.people.length ?? 0,
  };

  return {
    company,
    vision: visionOf(facts),
    goals: [],
    teams: onboardingTeams(facts),
    tools: [],
    sources: onboardingSources(facts),
    statements: [],
    candidates: [],
    gaps: [],
    workflows: [],
    connections,
    landscape: [],
    policies: [],
  };
};

/**
 * The company brain over `/rpc`: for anyone signed in. Its workspace isn't
 * audited itself: it reads nothing from Knowledge. Its changes are, as the
 * Knowledge read they are (brain-changes.ts).
 */
export class BrainRpc extends CoreRpcTarget implements BrainApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async read(): Promise<Workspace> {
    return await withPerson(
      this.#check,
      async (person) => await readBrain(this.#env, person)
    );
  }

  async changes(options: unknown): Promise<BrainChangePage> {
    return await withPerson(
      this.#check,
      async (person) =>
        await brainChanges(
          this.#env,
          person,
          options,
          sourceChanges(await onboardingFacts(this.#env, person))
        )
    );
  }
}
