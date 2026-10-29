import { addDays } from "@grasp-os/shared/admin/org-record";
import type {
  BrainApi,
  BrainChangePage,
  BrainForgetPreview,
  BrainNotePage,
  Company,
  Connection,
  Gap,
  Goal,
  Source,
  Stakeholder,
  Team,
  Tool,
  Transcript,
  Vision,
  Workspace,
} from "@grasp-os/shared/brain";
import { onboardingIdPrefix } from "@grasp-os/shared/brain-records";
import type {
  BrainRecordInput,
  BrainRecordsAdded,
} from "@grasp-os/shared/brain-records";
import type { CatalogSource } from "@grasp-os/shared/connect";
import type { KickoffView } from "@grasp-os/shared/kickoff";
import { purgedMarker } from "@grasp-os/shared/knowledge";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "./auth/auth.ts";
import { brainChanges } from "./brain-changes.ts";
import type { SourceChange } from "./brain-changes.ts";
import { forget, forgetPreview } from "./brain-forget.ts";
import {
  answerGap,
  askAboutGap,
  closeGap,
  gapsWith,
  redactGapAnswer,
} from "./brain-gaps.ts";
import { brainNotes } from "./brain-notes.ts";
import {
  addBrainRecords,
  datedInOrder,
  readBrainRecords,
} from "./brain-records.ts";
import type { HeldRecords, OnboardingHeld } from "./brain-records.ts";
import {
  brainTranscript,
  knowledgeTranscriptSources,
} from "./brain-transcripts.ts";
import { catalogEntries, personOf } from "./connections.ts";
import { organizations } from "./db/core/schema.ts";
import { brainOf } from "./knowledge/ports.ts";
import { intakeIds } from "./onboarding/brain-intake.ts";
import {
  isKickoffTeam,
  kickoffSaid,
  kickoffSourceId,
} from "./onboarding/kickoff-records.ts";
import { mondayOf } from "./onboarding/rules.ts";
import { onboardingStore } from "./onboarding/store.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { visibleApps } from "./workflows/overview.ts";

// The company brain's workspace (`brain.read`), assembled from what core
// already holds, each part as the person may read it, so the brain shows
// no one more than the reads it is built from would:
//
// | Workspace          | From                                                     |
// | ------------------ | -------------------------------------------------------- |
// | company            | the organization's name; the kickoff's `business` and    |
// |                    | the roster's head count for admins                       |
// | vision             | the brain's newest vision record, as the kickoff set it  |
// |                    | (onboarding/kickoff-records.ts), for everyone signed in; |
// |                    | the roster's teams taking part, for admins               |
// | teams              | the roster (admins), then the brain's team records; a    |
// |                    | team the kickoff named joins the team of its name        |
// | sources            | the kickoff, the roster, each team lead's finished       |
// |                    | interview and the documents shared in the onboarding     |
// |                    | (admins); each team's interviews, once the brain holds   |
// |                    | what they learned, for whoever reads records naming them |
// |                    | (never with a transcript); Knowledge documents saved     |
// |                    | with a transcript, for whoever may read them, by turn    |
// |                    | count (brain-transcripts.ts)                             |
// | tools              | the tools those documents name (admins)                  |
// | connections        | the catalog's offered entries and the person's           |
// |                    | connections                                              |
// | sources, tools,    | the brain's records (brain-records.ts), for everyone     |
// | candidates,        | signed in, after the onboarding's; a record's counts and |
// | statements, teams, | stakeholders for an onboarding team join that team, for  |
// | gaps               | whoever reads it; gaps with what became of them.         |
// |                    | The onboarding's statements are the team's claims five   |
// |                    | or more of its people made (GRA-1084)                    |
// | workflows          | the brain's records, as the onboarding drew them, for    |
// |                    | everyone signed in                                       |
//
// Grasp's staff are admins, and read what admins read (Nick,
// 2026-10-25): that each of their reads is audited and visible to the
// client is GRA-1087's.
// | goals              | the brain's records, for everyone signed in; each goal's |
// |                    | linked workflows only as far as the person may see their |
// |                    | App, while it still has them                             |
// | landscape,         | nothing core can read holds them yet: empty              |
// | policies           |                                                          |
//
// The onboarding (who works where, the kickoff, the interviews' progress,
// the documents shared) is the admin's: its own RPC shows the roster, the
// progress and the documents to admins alone, and the kickoff to Grasp's
// staff, who are admins. The kickoff is the company's sponsor speaking for the
// company: its vision and the teams it named are the company's, so the
// onboarding gives them to the brain as records every member reads
// (GRA-528), never its transcript or quotes. Its business reaches the
// company's admins here. Everyone else gets the brain without the rest. No
// interview's words reach the brain: the onboarding keeps them for staff
// alone, so sources carry no transcript. A team lead's interview shows as
// its team's stakeholder interview: only someone who led the team when
// their link went out, as the admin's progress counts them, and only by
// the week it finished in, from the week after. An employee's never does,
// as the admin sees employees only as counts per team. A shared document shows by its name and date, and
// the tools its reading names, used by the teams it names: what the
// admin's own list of them shows, never its text.
//
// The brain's records are company facts with no person in them (no
// author, no transcript), added by admins (`brain.addRecords`), so every
// member reads them. The Intake App's statements and sources and the
// workflow map's workflows stay in each App's own store, which only its
// builders reach (#716): they reach the brain only as records added here.

/** Who works where, as the admin gave it: the source of the teams' sizes. */
const rosterSourceId = "src-roster";

/**
 * Ids by where they come from. A roster team keeps its own id (letters,
 * digits, - and _), so the others take a `.` it can't have, and never
 * meet one of its.
 */
const ids = {
  rosterTeam: (id: string) => `team-${id}`,
  leadInterview: (rosterTeamId: string) => `src.lead-${rosterTeamId}`,
  document: (id: string) => `src.document-${id}`,
  documentTool: (slug: string) => `tool.document-${slug}`,
};

/** The day of an ISO 8601 moment: `YYYY-MM-DD`. */
const dayOf = (iso: string): string => iso.slice(0, 10);

/** A team's name as two sources can both mean it: trimmed, any case. */
const nameKey = (name: string): string => name.trim().toLowerCase();

/**
 * Whether teams of `name` may be joined by it: not one a purge rewrote
 * (its terms replaced by `purgedMarker`), which could name an unrelated
 * team the same way.
 */
const joinable = (name: string): boolean =>
  !name.toLowerCase().includes(purgedMarker.toLowerCase());

/** A tool's name as an id part: its letters and digits, any case, joined by `-`; empty when it has none. */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

/** What the onboarding gives the brain, for an admin; nothing for anyone else. */
interface OnboardingFacts {
  view: OnboardingView;
  kickoff: KickoffView;
  /** When the kickoff the brain names came in, a forgotten one's too (the store's `kickoffSourceAt`). */
  kickoffSourceAt: string | null;
  rosterSavedAt: string | null;
  sentLinks: { person: string; sentAt: string }[];
  /** Who talked as each roster team's lead, and the day they finished, as the view counts them. */
  leadsTalked: { team: string; person: string; day: string }[];
  /** The documents shared in the onboarding, newest first. */
  documents: OnboardingDocument[];
  /** Each team's interviews the brain holds what they learned of. */
  interviews: CameIn[];
}

/** A source the onboarding gives the brain, and when it came in (ISO 8601): when `brain.changes` shows it. */
interface CameIn {
  source: Source;
  at: string;
}

/**
 * Each team's interviews the brain holds what they learned of, as the one
 * source its statements and drawings name (onboarding/brain-intake.ts):
 * how many of its people agreed, and the week the first did, never who.
 */
const teamInterviews = async (env: Env): Promise<CameIn[]> => {
  const teams = await onboardingStore(env).interviewSources();
  return await Promise.all(
    teams.map(async ({ team, name, people, since }) => ({
      source: {
        id: await intakeIds.interviews(team),
        kind: "interview",
        title: `Interviews with ${name}`,
        date: mondayOf(since),
        how: people === 1 ? "1 person" : `${people} people`,
        step: 2,
        interviewee: "employee",
        teamIds: [ids.rosterTeam(team)],
      },
      at: `${mondayOf(since)}T00:00:00.000Z`,
    }))
  );
};

const onboardingFacts = async (
  env: Env,
  person: Identity
): Promise<OnboardingFacts | null> => {
  if (!isAdmin(person.role)) {
    return null;
  }
  const store = onboardingStore(env);
  const [
    view,
    kickoff,
    kickoffSourceAt,
    rosterSavedAt,
    sentLinks,
    leadsTalked,
    documents,
    interviews,
  ] = await Promise.all([
    store.view(),
    store.kickoff(),
    store.kickoffSourceAt(),
    store.rosterSavedAt(),
    store.sentLinks(),
    store.leadsTalked(),
    store.documents(),
    teamInterviews(env),
  ]);
  return {
    view,
    kickoff,
    kickoffSourceAt,
    rosterSavedAt,
    sentLinks,
    leadsTalked,
    documents,
    interviews,
  };
};

/** A team lead's role, never their name: their title, or "Team lead" without one. */
const roleOf = (lead: { title: string }): string =>
  lead.title === "" ? "Team lead" : lead.title;

/** The brain's teams by name (`nameKey`), as a reading names them. */
type TeamsByName = ReadonlyMap<string, string>;

/** The first of `teams` of each name: the roster's before the records'. */
const teamsByName = (teams: readonly Team[]): TeamsByName =>
  new Map(
    teams
      .filter(({ name }) => joinable(name))
      .toReversed()
      .map(({ id, name }) => [nameKey(name), id])
  );

/** The ids of the brain's teams `names` name, once each; names it has no team for are left out. */
const teamIdsNamed = (
  names: readonly string[],
  byName: TeamsByName
): string[] => [
  ...new Set(
    names.flatMap((name) => {
      const id = byName.get(nameKey(name));
      return id === undefined ? [] : [id];
    })
  ),
];

/**
 * Each roster team's lead's finished interview, as its stakeholder
 * interview: for which team, by what role and in which week, never what
 * was said. Only someone who led the team when their link went out and
 * gave a lead's interview for that team counts (onboarding/rules.ts,
 * `leadsTalked`): that is what keeps anyone else's interview out. The week
 * is presentation, not a privacy bound (the admin's progress already shows
 * the day): the interview is dated by the Monday of the week it finished
 * in, and shown from the Monday after.
 */
const leadInterviews = (
  facts: OnboardingFacts | null,
  today: string
): CameIn[] => {
  const roster = facts?.view.roster;
  if (facts === null || roster === null || roster === undefined) {
    return [];
  }
  return facts.leadsTalked.flatMap(({ team: teamId, person, day }) => {
    const team = roster.teams.find(({ id }) => id === teamId);
    const week = mondayOf(day);
    const shownFrom = addDays(week, 7);
    if (team === undefined || today < shownFrom) {
      return [];
    }
    const lead = roster.people.find(({ id }) => id === person);
    return [
      {
        source: {
          id: ids.leadInterview(team.id),
          kind: "interview",
          title: `Interview with ${team.name}`,
          date: week,
          who: lead === undefined ? "Team lead" : roleOf(lead),
          step: 2,
          interviewee: "stakeholder",
          teamIds: [ids.rosterTeam(team.id)],
        },
        at: `${shownFrom}T00:00:00.000Z`,
      },
    ];
  });
};

/**
 * The documents shared in the onboarding, oldest first: their names and
 * when they were shared. Not the teams their readings name: a source's
 * teams are the teams it speaks for, which makes them interviewed, and a
 * document isn't an interview. Those teams use the tools it names.
 */
const documentSources = (facts: OnboardingFacts | null): CameIn[] =>
  (facts?.documents ?? []).toReversed().map((document) => ({
    source: {
      id: ids.document(document.id),
      kind: "document",
      title: document.name,
      date: dayOf(document.at),
      step: 2,
    },
    at: document.at,
  }));

/**
 * The tools the shared documents' readings name, one per name as people
 * mean it (`nameKey`: trimmed, any case), each with an id of its own,
 * found in the oldest document naming it, used by every team a document
 * naming it is about. Whether it has AI nobody said: left out.
 */
const documentTools = (
  facts: OnboardingFacts | null,
  byName: TeamsByName
): Tool[] => {
  const tools = new Map<string, Tool>();
  // Two names whose letters and digits read alike ("Microsoft Project",
  // "Microsoft.Project") are two tools: the later one's id takes a number.
  // Documents are read oldest first, so an id never changes.
  const slugs = new Set<string>();
  const idFor = (name: string): string => {
    const base = slugOf(name) || "tool";
    let slug = base;
    for (let count = 2; slugs.has(slug); count += 1) {
      slug = `${base}-${count}`;
    }
    slugs.add(slug);
    return ids.documentTool(slug);
  };
  for (const document of (facts?.documents ?? []).toReversed()) {
    const teamIds = teamIdsNamed(document.reading.teams, byName);
    for (const name of document.reading.tools) {
      const key = nameKey(name);
      if (key === "") {
        continue;
      }
      const held = tools.get(key);
      tools.set(
        key,
        held === undefined
          ? {
              id: idFor(name),
              name: name.trim(),
              teamIds,
              sourceId: ids.document(document.id),
            }
          : { ...held, teamIds: [...new Set([...held.teamIds, ...teamIds])] }
      );
    }
  }
  return [...tools.values()];
};

/**
 * The brain's tools, one per name as people mean it (`nameKey`), as
 * `onboardingTeams` merges teams: a document's tool the brain has a
 * record of too is that record, which keeps its id and source (statements
 * name it by that id), used by the teams of both. Records are never
 * merged with each other: each is a fact of its own, which statements may
 * name by its id.
 */
const toolsOf = (
  documents: readonly Tool[],
  records: readonly Tool[]
): Tool[] => {
  const recorded = new Map<string, Tool>();
  for (const tool of records) {
    const key = nameKey(tool.name);
    if (!recorded.has(key)) {
      recorded.set(key, tool);
    }
  }
  const merged = new Map<string, string[]>();
  const fromDocuments = documents.filter(({ name, teamIds }) => {
    const record = recorded.get(nameKey(name));
    if (record === undefined) {
      return true;
    }
    merged.set(record.id, [...(merged.get(record.id) ?? []), ...teamIds]);
    return false;
  });
  return [
    ...fromDocuments,
    ...records.map((tool) => {
      const teamIds = merged.get(tool.id);
      return teamIds === undefined
        ? tool
        : { ...tool, teamIds: [...new Set([...tool.teamIds, ...teamIds])] };
    }),
  ];
};

/**
 * The onboarding's sources, each with when it came in: the kickoff when
 * its transcript came in, the staff list when it was last saved, the team
 * leads' interviews and the documents shared. The one definition of which
 * sources there are and what they are called, for `brain.read` and
 * `brain.changes` alike; none for anyone but an admin, who alone has
 * `facts`.
 */
const onboardingSources = (
  facts: OnboardingFacts | null,
  today: string = dayOf(new Date().toISOString())
): CameIn[] => {
  // A kickoff a purge forgot stays a source by its title and day alone:
  // the records the purge rewrote still name it.
  const kickoffAt = facts?.kickoffSourceAt ?? undefined;
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
            },
            at: kickoffAt,
          } satisfies CameIn,
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
            },
            at: facts.rosterSavedAt,
          } satisfies CameIn,
        ]),
    ...leadInterviews(facts, today),
    ...documentSources(facts),
    ...(facts?.interviews ?? []),
  ];
};

/** Whether `id` is a team's interviews, as the onboarding gives them the brain. */
const isTeamInterviews = (id: string): boolean =>
  id.startsWith(`${onboardingIdPrefix}src-`);

/**
 * The onboarding's sources `named` (the kickoff, the staff list, a team's
 * interviews), for a
 * member whose brain holds records naming them: only what
 * `onboardingSources` says of each (its title and when it came in),
 * never what it says.
 */
const sourcesForRecords = async (
  env: Env,
  named: ReadonlySet<string>
): Promise<Source[]> => {
  if (named.size === 0) {
    return [];
  }
  const store = onboardingStore(env);
  const [kickoff, kickoffSourceAt, view, rosterSavedAt, interviews] =
    await Promise.all([
      store.kickoff(),
      store.kickoffSourceAt(),
      store.view(),
      store.rosterSavedAt(),
      [...named].some(isTeamInterviews) ? teamInterviews(env) : [],
    ]);
  const facts: OnboardingFacts = {
    view,
    kickoff,
    kickoffSourceAt,
    rosterSavedAt,
    sentLinks: [],
    leadsTalked: [],
    documents: [],
    interviews,
  };
  return onboardingSources(facts).flatMap(({ source }) =>
    named.has(source.id) ? [source] : []
  );
};

/** The onboarding's sources as changes (brain-changes.ts), with the ids and titles `brain.read` gives them. */
const sourceChanges = (facts: OnboardingFacts | null): SourceChange[] =>
  onboardingSources(facts).map(({ source: { id, title }, at }) => ({
    id,
    title,
    at,
  }));

/**
 * The roster's teams. Each one's size is its people, its roles their
 * titles counted (how many, never who), and its stakeholder its lead, as
 * their title.
 */
const onboardingTeams = (facts: OnboardingFacts | null): Team[] => {
  if (facts === null) {
    return [];
  }
  const { view, rosterSavedAt, sentLinks } = facts;
  const roster = view.roster ?? { teams: [], people: [] };
  const rosterDay = rosterSavedAt === null ? null : dayOf(rosterSavedAt);
  const sentAt = new Map(
    sentLinks.map(({ person, sentAt: at }) => [person, at])
  );
  return roster.teams.map((team): Team => {
    const members = roster.people.filter(({ team: id }) => id === team.id);
    const titles = new Map<string, number>();
    for (const { title } of members) {
      if (title !== "") {
        titles.set(title, (titles.get(title) ?? 0) + 1);
      }
    }
    const lead = members.find(({ id }) => id === team.lead);
    const invitedAt = lead === undefined ? undefined : sentAt.get(lead.id);
    const stakeholders: Stakeholder[] =
      lead === undefined || rosterDay === null
        ? []
        : [
            {
              // A role, never the lead's name.
              role: roleOf(lead),
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
      sourceId: rosterSourceId,
      counts:
        rosterDay === null
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
            ],
      stakeholders,
    };
  });
};

/**
 * The vision page: the brain's newest vision, as the kickoff set it, with
 * every version before it counted; empty, but for its teams, until one is
 * in.
 */
const visionOf = (
  records: HeldRecords,
  facts: OnboardingFacts | null
): Vision => {
  const newest = records.visions.at(-1);
  return {
    // The kickoff's goals are "the goals for the next one to two years,
    // and why AI now"; its pain, "the work the sponsor already suspects
    // costs too much time", is why now.
    ambition: newest?.ambition ?? "",
    whyNow: newest?.whyNow ?? "",
    // The teams the interviews go to: every roster team taking part.
    inviteTeamIds: (facts?.view.roster?.teams ?? [])
      .filter(({ off }) => !off)
      .map(({ id }) => ids.rosterTeam(id)),
    // Nothing asks the board for a budget or who approves tools yet.
    budget: [],
    toolApproval: [],
    sourceId: newest?.sourceId ?? "",
    // Nobody confirms a vision page yet: each change the kickoff brought
    // is a version.
    version: records.visions.length,
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

/**
 * `teams` with each team the kickoff named joined to the team of its name
 * (any case): a roster team, or its record, found first in the kickoff,
 * with the size the sponsor gave beside the others. A kickoff team no
 * other team is named as stays a team of its own.
 */
const withKickoffTeams = (teams: Team[]): Team[] => {
  const byName = new Map<string, Team>();
  for (const team of teams) {
    const key = nameKey(team.name);
    if (!isKickoffTeam(team.id) && joinable(team.name) && !byName.has(key)) {
      byName.set(key, team);
    }
  }
  const joined = teams.filter((team) => {
    if (!isKickoffTeam(team.id) || !joinable(team.name)) {
      return true;
    }
    const into = byName.get(nameKey(team.name));
    if (into === undefined) {
      byName.set(nameKey(team.name), team);
      return true;
    }
    // Found first in the kickoff: its values go before the others of
    // their day, so a newer source's count counts.
    into.sourceId = kickoffSourceId;
    into.counts = [...team.counts, ...into.counts];
    into.stakeholders = [...team.stakeholders, ...into.stakeholders];
    return false;
  });
  for (const team of joined) {
    datedInOrder(team);
  }
  return joined;
};

/**
 * The onboarding's teams, with what the records added for each, then the
 * records' own. A value for a team the person can't see is left out. A
 * roster team's record (onboarding/brain-intake.ts) is that team, for
 * whoever can't read the roster: for an admin, the roster's team, which
 * is newer, with what was added for it.
 */
const teamsOf = (onboarding: Team[], records: HeldRecords): Team[] => {
  const byId = new Map(onboarding.map((team) => [team.id, team]));
  const own = records.teams.filter((team) => {
    const roster = byId.get(team.id);
    roster?.counts.push(...team.counts);
    roster?.stakeholders.push(...team.stakeholders);
    return roster === undefined;
  });
  // Values for a team record were joined to it already; these are for the
  // onboarding's teams, or (`withSuccessors`) moved to a record from a
  // retired team.
  for (const team of own) {
    byId.set(team.id, team);
  }
  for (const { teamId, value } of records.teamCounts) {
    byId.get(teamId)?.counts.push(value);
  }
  for (const { teamId, value } of records.stakeholders) {
    byId.get(teamId)?.stakeholders.push(value);
  }
  return withKickoffTeams([...onboarding, ...own]);
};

/**
 * `records` with whatever names a team nobody reads as itself naming the
 * team that reads in its place: a retired team (a replaced kickoff's), the
 * first team of its name (any case), the roster's before the records';
 * and a kickoff team joined to a team of its name (`withKickoffTeams`),
 * that team. What admins added for it (a stakeholder, a count, a
 * statement's team, a tool's, a source's, a gap's or a workflow's) is
 * never left behind on a team nobody reads. A retired team no team is
 * named as yet keeps them. A joined kickoff team's counts and
 * stakeholders stay its own: the join takes them, ordered as the kickoff
 * found them.
 */
const withSuccessors = (
  onboarding: Team[],
  records: HeldRecords
): HeldRecords => {
  const byName = teamsByName([...onboarding, ...records.teams]);
  const successor = new Map(
    records.retiredTeams.flatMap(({ id, name }) => {
      const to = byName.get(nameKey(name));
      return to === undefined || to === id ? [] : [[id, to] as const];
    })
  );
  // A live kickoff team joins the first other team of its name, as
  // `withKickoffTeams` joins them.
  const others = teamsByName(
    [...onboarding, ...records.teams].filter(({ id }) => !isKickoffTeam(id))
  );
  const joined = new Map(
    records.teams.flatMap(({ id, name }) => {
      const to = others.get(nameKey(name));
      return isKickoffTeam(id) && to !== undefined && to !== id
        ? [[id, to] as const]
        : [];
    })
  );
  if (successor.size === 0 && joined.size === 0) {
    return records;
  }
  const one = (id: string): string => successor.get(id) ?? id;
  const read = (id: string): string => joined.get(one(id)) ?? one(id);
  const all = (named: string[]): string[] => [...new Set(named.map(read))];
  return {
    ...records,
    teamCounts: records.teamCounts.map((each) => ({
      ...each,
      teamId: one(each.teamId),
    })),
    stakeholders: records.stakeholders.map((each) => ({
      ...each,
      teamId: one(each.teamId),
    })),
    sources: records.sources.map((source) =>
      source.teamIds === undefined
        ? source
        : { ...source, teamIds: all(source.teamIds) }
    ),
    tools: records.tools.map((tool) => ({
      ...tool,
      teamIds: all(tool.teamIds),
    })),
    statements: records.statements.map((statement) => ({
      ...statement,
      teamIds: all(statement.teamIds),
    })),
    gaps: records.gaps.map((gap) => ({ ...gap, about: all(gap.about) })),
    workflows: records.workflows.map((workflow) => ({
      ...workflow,
      ...(workflow.teamId === undefined
        ? {}
        : { teamId: read(workflow.teamId) }),
    })),
  };
};

/** The sources `team` names: where it was found, and each of its values. */
const teamSources = ({ sourceId, counts, stakeholders }: Team): string[] => [
  sourceId,
  ...counts.map((count) => count.sourceId),
  ...stakeholders.map((stakeholder) => stakeholder.sourceId),
];

/**
 * The brain's gaps, with what became of each, as every member reads
 * them: what `brain.read` serves, and what a chat's agent reads too.
 */
export const brainGaps = async (
  env: Env,
  // The one access point the brain page and an agent share: per-team gaps
  // would be filtered here for both. Today every member reads every gap.
  _person: Pick<Identity, "userId" | "role" | "teams">,
  // The records `brain.read` loaded already, so it reads them once.
  loaded?: HeldRecords
): Promise<Gap[]> => {
  const { gaps } = loaded ?? (await readBrainRecords(env));
  return await gapsWith(env, gaps);
};

/**
 * What the onboarding gives the brain now, that a record may name: its
 * sources, the kickoff once brought in and the staff list once saved, and
 * the roster's teams, by the ids the admin gave them. The kickoff's teams
 * are records of their own.
 */
const onboardingHeld = async (env: Env): Promise<OnboardingHeld> => {
  const store = onboardingStore(env);
  const [kickoffSourceAt, view, rosterSavedAt] = await Promise.all([
    store.kickoffSourceAt(),
    store.view(),
    store.rosterSavedAt(),
  ]);
  const rosterTeams = view.roster?.teams ?? [];
  return {
    sources: new Set([
      ...(kickoffSourceAt === null ? [] : [kickoffSourceId]),
      ...(view.roster === null || rosterSavedAt === null
        ? []
        : [rosterSourceId]),
    ]),
    teams: new Set(rosterTeams.map(({ id }) => ids.rosterTeam(id))),
  };
};

/**
 * The board's goals (`goals`), each with the workflows linked to it that
 * `person` may see: whose App they may see, and that App's current
 * version still has. The rest are left out, so a goal never names an App
 * or a workflow its reader couldn't open.
 */
export const goalsFor = async (
  env: Env,
  person: Identity,
  goals: readonly Goal[]
): Promise<Goal[]> => {
  if (goals.every(({ workflows }) => workflows.length === 0)) {
    return [...goals];
  }
  const visible = await visibleApps(env, person);
  const seen = new Set(
    visible.flatMap(({ id, workflows }) =>
      workflows.map((workflow) => `${id}/${workflow}`)
    )
  );
  return goals.map((goal) => ({
    ...goal,
    workflows: goal.workflows.filter(({ app, workflow }) =>
      seen.has(`${app}/${workflow}`)
    ),
  }));
};

/** The brain's workspace, as `person` may read it. */
export const readBrain = async (
  env: Env,
  person: Identity
): Promise<Workspace> => {
  const [facts, name, connections, held, transcribed] = await Promise.all([
    onboardingFacts(env, person),
    organizationName(env),
    connectionsOf(env, person),
    readBrainRecords(env),
    knowledgeTranscriptSources(env, person),
  ]);
  const onboarding = onboardingTeams(facts);
  const records = withSuccessors(onboarding, held);

  const company: Company = {
    name,
    sector: facts === null ? "" : kickoffSaid(facts.kickoff, "business"),
    people: facts?.view.roster?.people.length ?? 0,
  };

  const teams = teamsOf(onboarding, records);
  // A member reads the onboarding's sources only as the records it reads
  // name them: when each came in, so a fact shows where it came from.
  const named = new Set(
    [
      ...[...records.tools, ...records.statements, ...records.gaps].map(
        ({ sourceId }) => sourceId
      ),
      ...records.workflows.flatMap(({ drawings }) =>
        (drawings ?? []).map(({ sourceId }) => sourceId)
      ),
      ...records.goals.flatMap(({ versions }) =>
        versions.map(({ sourceId }) => sourceId)
      ),
      ...teams.flatMap(teamSources),
      ...records.visions.map(({ sourceId }) => sourceId),
    ].filter(
      (id) =>
        id === kickoffSourceId || id === rosterSourceId || isTeamInterviews(id)
    )
  );
  const sources =
    facts === null
      ? await sourcesForRecords(env, named)
      : onboardingSources(facts).map(({ source }) => source);

  return {
    company,
    vision: visionOf(records, facts),
    goals: await goalsFor(env, person, records.goals),
    teams,
    tools: toolsOf(documentTools(facts, teamsByName(teams)), records.tools),
    sources: [...sources, ...records.sources, ...transcribed],
    statements: records.statements,
    candidates: records.candidates,
    gaps: await brainGaps(env, person, records),
    workflows: records.workflows,
    connections,
    landscape: [],
    policies: [],
  };
};

/**
 * The company brain over `/rpc`: for anyone signed in. Of its workspace,
 * only the Knowledge documents it lists as transcript sources are audited,
 * as the Knowledge read that listing is; the rest reads nothing from
 * Knowledge. Opening a source's transcript is audited as that one read
 * (brain-transcripts.ts). Its changes are, as the Knowledge read they are
 * (brain-changes.ts). Adding records is, with the records it added;
 * taking them out is, by each record's key (brain-forget.ts).
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

  async goals(): Promise<Goal[]> {
    return await withPerson(this.#check, async (person) => {
      const { goals } = await readBrainRecords(this.#env);
      return await goalsFor(this.#env, person, goals);
    });
  }

  async transcript(sourceId: unknown): Promise<Transcript | null> {
    return await withPerson(
      this.#check,
      async (person) => await brainTranscript(this.#env, person, sourceId)
    );
  }

  async notes(options?: unknown): Promise<BrainNotePage> {
    return await withPerson(
      this.#check,
      async (person) => await brainNotes(brainOf(this.#env), person, options)
    );
  }

  async changes(options: unknown): Promise<BrainChangePage> {
    return await withPerson(
      this.#check,
      async (person) =>
        await brainChanges(
          brainOf(this.#env),
          person,
          options,
          sourceChanges(await onboardingFacts(this.#env, person))
        )
    );
  }

  async addRecords(records: BrainRecordInput[]): Promise<BrainRecordsAdded> {
    return await withPerson(
      this.#check,
      async (person) =>
        await addBrainRecords(
          this.#env,
          person,
          records,
          async () => await onboardingHeld(this.#env)
        )
    );
  }

  async forgetPreview(target: unknown): Promise<BrainForgetPreview> {
    return await withPerson(
      this.#check,
      async (person) => await forgetPreview(this.#env, person, target)
    );
  }

  async forget(target: unknown): Promise<BrainForgetPreview> {
    return await withPerson(
      this.#check,
      async (person) => await forget(this.#env, person, target)
    );
  }

  async askAboutGap(gapId: string): Promise<Gap> {
    return await withPerson(
      this.#check,
      async (person) => await askAboutGap(this.#env, person, gapId)
    );
  }

  async answerGap(gapId: string, answer: string): Promise<Gap> {
    return await withPerson(
      this.#check,
      async (person) => await answerGap(this.#env, person, gapId, answer)
    );
  }

  async redactGapAnswer(gapId: string): Promise<Gap> {
    return await withPerson(
      this.#check,
      async (person) => await redactGapAnswer(this.#env, person, gapId)
    );
  }

  async closeGap(gapId: string): Promise<Gap> {
    return await withPerson(
      this.#check,
      async (person) => await closeGap(this.#env, person, gapId)
    );
  }
}
