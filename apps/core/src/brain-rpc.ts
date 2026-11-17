import { addDays } from "@grasp-os/shared/admin/org-record";
import type {
  BrainApi,
  BrainForgetPreview,
  Company,
  Connection,
  Gap,
  Goal,
  Source,
  Stakeholder,
  Statement,
  Team,
  TeamGroup,
  ThinkingGround,
  Tool,
  Vision,
  Workflow,
  Workspace,
} from "@grasp-os/shared/brain";
import { onboardingIdPrefix } from "@grasp-os/shared/brain-records";
import type {
  BrainRecordInput,
  BrainRecordsAdded,
} from "@grasp-os/shared/brain-records";
import type { ConnectionSource } from "@grasp-os/shared/connect";
import type { KickoffView } from "@grasp-os/shared/kickoff";
import { minTeamShown } from "@grasp-os/shared/onboarding";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { hoursPerWeek } from "@grasp-os/shared/thinking";
import type { WorkKnowledge } from "@grasp-os/shared/work-knowledge";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "./auth/auth.ts";
import { forget, forgetPreview } from "./brain-forget.ts";
import {
  answerGap,
  askAboutGap,
  closeGap,
  gapsWith,
  redactGapAnswer,
} from "./brain-gaps.ts";
import {
  addBrainRecords,
  datedInOrder,
  readBrainRecords,
  stepsOf,
} from "./brain-records.ts";
import type { HeldRecords, OnboardingHeld } from "./brain-records.ts";
import {
  proposeTeamGroups,
  saveTeamGroups,
  teamGroupsOf,
} from "./brain-team-groups.ts";
import { askMorePeople, workKnowledge } from "./brain-work.ts";
import { mayHoldCapturesOf } from "./connection-capture-key.ts";
import { catalogEntries, personOf } from "./connections.ts";
import { organizations } from "./db/core/schema.ts";
import { intakeIds, ownId } from "./onboarding/brain-intake.ts";
import type { CompanyTeam } from "./onboarding/company-teams.ts";
import { kickoffSaid, teamNameKey } from "./onboarding/kickoff-company.ts";
import type { CompanyKickoff } from "./onboarding/kickoff-company.ts";
import { mondayOf } from "./onboarding/rules.ts";
import { onboardingStore } from "./onboarding/store.ts";
import type { StandingClaim, StandingDrawing } from "./onboarding/store.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { listWorkflowResources } from "./workflow-resources.ts";

// The company brain's workspace (`brain.read`), assembled from what core
// already holds, each part as the person may read it, so the brain shows
// no one more than the reads it is built from would:
//
// | Workspace          | From                                                     |
// | ------------------ | -------------------------------------------------------- |
// | company            | the organization's name; the kickoff's `business` and    |
// |                    | the roster's head count for admins                       |
// | vision             | the kickoff's vision (onboarding/kickoff-company.ts),    |
// |                    | for everyone signed in; the roster's teams taking part,  |
// |                    | for admins                                               |
// | teams              | the roster (admins), the teams the kickoff named (with   |
// |                    | their sizes, for everyone signed in), the confirmed      |
// |                    | roster's teams taking part (everyone else), then the     |
// |                    | brain's team records; a team the kickoff named joins the |
// |                    | team of its name                                         |
// | sources            | the kickoff, the roster, each team lead's finished       |
// |                    | interview and the documents shared in the onboarding     |
// |                    | (admins); each team's interviews, while its results may  |
// |                    | show, for whoever reads what names them (never with a    |
// |                    | transcript)                                              |
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
// | teamGroups         | the company's groups of teams (brain-team-groups.ts),    |
// |                    | for everyone signed in, naming only the reader's teams   |
// | interviewWeeks     | the interviews the brain learned from, five or more a    |
// |                    | week, never who or which day (the onboarding's store),   |
// |                    | for everyone signed in                                   |
// | goals              | the brain's records, for everyone signed in; each goal's |
// |                    | linked workflows only those the person has a role in     |
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

/** The kickoff, as the source of the vision and of the teams it named. */
const kickoffSourceId = "src-kickoff";

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
const nameKey = teamNameKey;

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
  /** When the kickoff the brain names came in (the store's `kickoffSourceAt`). */
  kickoffSourceAt: string | null;
  rosterSavedAt: string | null;
  sentLinks: { person: string; sentAt: string }[];
  /** Who talked as each roster team's lead, and the day they finished, as the view counts them. */
  leadsTalked: { team: string; person: string; day: string }[];
  /** The documents shared in the onboarding, newest first. */
  documents: OnboardingDocument[];
  /** Each team's interviews, while its results may show. */
  interviews: CameIn[];
}

/** A source the onboarding gives the brain, and when it came in (ISO 8601). */
interface CameIn {
  source: Source;
  at: string;
}

/**
 * Each team's interviews while its results may show, as the one source
 * its claims and drawings name (onboarding/brain-intake.ts): how many of
 * its people agreed, and the week the first did, never who.
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
  person: Pick<Identity, "role">
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
  new Map(teams.toReversed().map(({ id, name }) => [nameKey(name), id]));

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
 * sources there are and what they are called, for `brain.read`; none
 * for anyone but an admin, who alone has `facts`.
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

/**
 * The roster's teams as every member reads them (onboarding/company-teams.ts):
 * each confirmed team taking part, the admin's own description, and its head
 * count on the roster, never who is in it, their titles or its lead.
 */
const confirmedTeams = (
  confirmed: { at: string; teams: readonly CompanyTeam[] } | null
): Team[] =>
  (confirmed?.teams ?? []).map(({ id, name, does, people }) => ({
    id: ids.rosterTeam(id),
    name,
    ...(does === "" ? {} : { does }),
    sourceId: rosterSourceId,
    counts: [
      { sourceId: rosterSourceId, date: dayOf(confirmed?.at ?? ""), people },
    ],
    stakeholders: [],
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
      ...(team.does === "" ? {} : { does: team.does }),
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
 * The vision page: the kickoff's vision, as every member reads it
 * (onboarding/kickoff-company.ts); empty, but for its teams, until the
 * kickoff is in. Its history is the new Brain's, as versions of the
 * kickoff's source.
 */
const visionOf = (
  kickoff: CompanyKickoff | null,
  facts: OnboardingFacts | null
): Vision => ({
  // The kickoff's goals are "the goals for the next one to two years,
  // and why AI now"; its pain, "the work the sponsor already suspects
  // costs too much time", is why now.
  ambition: kickoff?.ambition ?? "",
  whyNow: kickoff?.whyNow ?? "",
  // The teams the interviews go to: every roster team taking part.
  inviteTeamIds: (facts?.view.roster?.teams ?? [])
    .filter(({ off }) => !off)
    .map(({ id }) => ids.rosterTeam(id)),
  // Nothing asks the board for a budget or who approves tools yet.
  budget: [],
  toolApproval: [],
  sourceId: kickoff === null ? "" : kickoffSourceId,
  // Nobody confirms a vision page yet.
  version: kickoff === null ? 0 : 1,
});

/** What starts the id of each team the kickoff names (`kickoffTeamsOf`). */
const kickoffTeamIdPrefix = `${onboardingIdPrefix}kt-`;

/**
 * The teams the kickoff named, each with the size the sponsor gave it,
 * as every member reads them (onboarding/kickoff-company.ts). Each one's
 * id follows from its name alone, as people mean it (`teamNameKey`), so a
 * transcript brought in again that names it, in any case, keeps it, with
 * what an admin's records added for it.
 */
const kickoffTeamsOf = async (
  kickoff: CompanyKickoff | null
): Promise<Team[]> => {
  if (kickoff === null) {
    return [];
  }
  const date = dayOf(kickoff.at);
  return await Promise.all(
    kickoff.teams.map(async ({ name, people }): Promise<Team> => ({
      id: await ownId("kt", teamNameKey(name)),
      name,
      sourceId: kickoffSourceId,
      counts:
        people === undefined
          ? []
          : [{ sourceId: kickoffSourceId, date, people }],
      stakeholders: [],
    }))
  );
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
const entryKey = (source: ConnectionSource, id: string): string =>
  `${source}:${id}`;

/** How Grasp connects to an entry: a native provider directly. */
const viaOf = (source: string): Connection["via"] =>
  source === "native" ? "direct" : "composio";

/**
 * The catalog's offered entries, each connected when the person has an
 * active connection to it (their own, or a shared one), and the active
 * connections to entries an admin hid or the catalog doesn't list (a toolkit it no longer
 * lists, say). A native provider is connected directly; a toolkit through
 * Composio. A connection matches the tool names that are its name. One
 * the Brain may keep some of the person's reads from says so
 * (`keepsReads`).
 */
const connectionsOf = async (
  env: Env,
  person: Identity
): Promise<Connection[]> => {
  const [entries, connecting] = await Promise.all([
    catalogEntries(env),
    personOf(env, person),
  ]);
  const listed = await env.CONNECT.listConnections(connecting);
  const activeListed = listed.filter(({ status }) => status === "active");
  const active = new Set(
    activeListed.map(({ source, provider }) => entryKey(source, provider))
  );
  // What capture keeps by and disconnecting erases by
  // (connection-capture-key.ts `mayHoldCapturesOf`): the person's own
  // connection of a kind capture keeps reads from. The same rule, so the
  // page never says nothing is kept from a connection that may hold some.
  const keeping = new Set(
    activeListed
      .filter((connection) => mayHoldCapturesOf(connection, connecting.userId))
      .map(({ source, provider }) => entryKey(source, provider))
  );
  const keepsReads = (key: string): { keepsReads?: true } =>
    keeping.has(key) ? { keepsReads: true } : {};
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
    ...keepsReads(entryKey(source, id)),
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
        ...keepsReads(each),
      };
    });
  return [...offered, ...unlisted];
};

/**
 * The roster's teams and the records' own (`own`), with each team the
 * kickoff named (`kickoff`) joined to the first of them of its name (any
 * case), found first in the kickoff, with the size the sponsor gave
 * beside the others. A kickoff team no other team is named as stays a
 * team of its own, after the roster's.
 */
const withKickoffTeams = (
  roster: Team[],
  kickoff: Team[],
  own: Team[]
): Team[] => {
  const byName = new Map<string, Team>();
  for (const team of [...roster, ...own]) {
    const key = nameKey(team.name);
    if (!byName.has(key)) {
      byName.set(key, team);
    }
  }
  const alone = kickoff.filter((team) => {
    const into = byName.get(nameKey(team.name));
    if (into === undefined) {
      return true;
    }
    // Found first in the kickoff: its values go before the others of
    // their day, so a newer source's count counts.
    into.sourceId = kickoffSourceId;
    into.counts = [...team.counts, ...into.counts];
    into.stakeholders = [...team.stakeholders, ...into.stakeholders];
    return false;
  });
  const teams = [...roster, ...alone, ...own];
  for (const team of teams) {
    datedInOrder(team);
  }
  return teams;
};

/**
 * The onboarding's teams (the roster's, and the kickoff's), with what the
 * records added for each, then the records' own. A value for a team the
 * person can't see is left out.
 */
const teamsOf = (
  roster: Team[],
  kickoff: Team[],
  records: HeldRecords
): Team[] => {
  // A team record never takes an onboarding team's id (`team-<id>`, an
  // `onb-` one): `brain.addRecords` refuses both.
  const byId = new Map(
    [...roster, ...kickoff, ...records.teams].map((team) => [team.id, team])
  );
  for (const { teamId, value } of records.teamCounts) {
    byId.get(teamId)?.counts.push(value);
  }
  for (const { teamId, value } of records.stakeholders) {
    byId.get(teamId)?.stakeholders.push(value);
  }
  return withKickoffTeams(roster, kickoff, records.teams);
};

/**
 * `records` with whatever names a kickoff team joined to a team of its
 * name (`withKickoffTeams`) naming that team: what admins added for it (a
 * statement's team, a tool's, a source's, a gap's or a workflow's) is
 * never left behind on a team nobody reads. A joined kickoff team's counts
 * and stakeholders stay its own: the join takes them, ordered as the
 * kickoff found them.
 */
const withSuccessors = (
  roster: Team[],
  kickoff: Team[],
  records: HeldRecords
): HeldRecords => {
  // A kickoff team joins the first other team of its name, as
  // `withKickoffTeams` joins them.
  const others = teamsByName([...roster, ...records.teams]);
  const joined = new Map(
    kickoff.flatMap(({ id, name }) => {
      const to = others.get(nameKey(name));
      return to === undefined || to === id ? [] : [[id, to] as const];
    })
  );
  if (joined.size === 0) {
    return records;
  }
  const read = (id: string): string => joined.get(id) ?? id;
  const all = (named: string[]): string[] => [...new Set(named.map(read))];
  return {
    ...records,
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
 * its teams: the roster's, by the ids the admin gave them, and the
 * kickoff's (`kickoffTeamsOf`).
 */
const onboardingHeld = async (env: Env): Promise<OnboardingHeld> => {
  const store = onboardingStore(env);
  const [kickoff, view, rosterSavedAt] = await Promise.all([
    store.companyKickoff(),
    store.view(),
    store.rosterSavedAt(),
  ]);
  const rosterTeams = view.roster?.teams ?? [];
  const kickoffTeams = await kickoffTeamsOf(kickoff);
  return {
    sources: new Set([
      ...(kickoff === null ? [] : [kickoffSourceId]),
      ...(view.roster === null || rosterSavedAt === null
        ? []
        : [rosterSourceId]),
    ]),
    teams: new Set([
      ...rosterTeams.map(({ id }) => ids.rosterTeam(id)),
      ...kickoffTeams.map(({ id }) => id),
    ]),
  };
};

/**
 * The board's goals (`goals`), each with the workflows linked to it that
 * `person` may see: the independent workflows they have a role in
 * (`listWorkflowResources`), none of them deleted. The rest are left out,
 * so a goal never names a workflow its reader couldn't open.
 */
export const goalsFor = async (
  env: Env,
  person: Identity,
  goals: readonly Goal[]
): Promise<Goal[]> => {
  if (goals.every(({ workflows }) => workflows.length === 0)) {
    return [...goals];
  }
  const workflows = await listWorkflowResources(env, person);
  const seen = new Set(workflows.map(({ id }) => id));
  return goals.map((goal) => ({
    ...goal,
    workflows: goal.workflows.filter((workflow) => seen.has(workflow)),
  }));
};

/**
 * `source` as the company may read who gave it: their role only where
 * five or more in its team hold that role now, else no one, so it never
 * points at one person. Every reader gets the same, so the floor holds
 * here, not only where the web labels it (witness.ts).
 */
const witnessed = (teams: readonly Team[], source: Source): Source => {
  const { who, ...rest } = source;
  if (who === undefined) {
    return source;
  }
  const team = teams.find(({ id }) => id === source.teamIds?.[0]);
  const counts = team?.counts
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .at(-1);
  const holders = counts?.roles?.find(({ name }) => name === who)?.people ?? 0;
  return holders >= minTeamShown ? source : rest;
};

/**
 * `records` without the kickoff's teams it no longer names: one a
 * replaced kickoff named, or an earlier release's (its record removed by
 * migration 0259), named by an admin's source, tool or statement. Such a
 * team is no one's to read, so it is left out, never shown by its bare
 * id, as its counts and stakeholders already are (`teamsOf`).
 */
const withoutGoneKickoffTeams = (
  records: HeldRecords,
  kickoff: readonly Team[]
): HeldRecords => {
  const named = new Set(kickoff.map(({ id }) => id));
  const kept = (teamIds: readonly string[]): string[] =>
    teamIds.filter(
      (id) => !id.startsWith(kickoffTeamIdPrefix) || named.has(id)
    );
  return {
    ...records,
    sources: records.sources.map((source) =>
      source.teamIds === undefined
        ? source
        : { ...source, teamIds: kept(source.teamIds) }
    ),
    tools: records.tools.map((tool) => ({
      ...tool,
      teamIds: kept(tool.teamIds),
    })),
    statements: records.statements.map((statement) => ({
      ...statement,
      teamIds: kept(statement.teamIds),
    })),
  };
};

/**
 * The team claims standing now (onboarding/store.ts `standingClaims`) as
 * the page's statements, for every member (GRA-1748): each in its team,
 * citing the team's interviews, never who backs it. Its id starts with the
 * onboarding's prefix, which no record an admin adds may take, and by
 * which the page knows a team's claim (apps/web `isTeamClaim`).
 */
const claimStatements = async (
  claims: readonly StandingClaim[]
): Promise<Statement[]> =>
  await Promise.all(
    claims.map(async ({ source, team, kind, text }) => ({
      id: `${onboardingIdPrefix}claim-${source}`,
      kind,
      text,
      sourceId: await intakeIds.interviews(team),
      teamIds: [intakeIds.team(team)],
      toolIds: [],
    }))
  );

/**
 * The drawings standing now (onboarding/store.ts `standingDrawings`) as
 * the page's workflows, for every member (GRA-1748): each piece of work in
 * its team with its one drawing, the drawing its baseline, citing the
 * team's interviews; never who told what. Its id is the one the
 * onboarding gives the piece of work, so what names it keeps naming it
 * through every drawing.
 */
const drawingWorkflows = (drawings: readonly StandingDrawing[]): Workflow[] =>
  drawings.map(({ workflow, team, name, local, drawing }) => {
    const { type: _type, workflowId: _workflow, ...value } = drawing;
    return {
      id: workflow,
      name,
      ...(local === undefined ? {} : { local }),
      teamId: intakeIds.team(team),
      status: "drawn",
      baseline: { steps: stepsOf(value) },
      drawings: [value],
    };
  });

/**
 * What every read of the brain starts from, as `person` may read it: the
 * onboarding (an admin's alone), the brain's records, and its teams.
 */
interface BrainCore {
  facts: OnboardingFacts | null;
  /** What every member reads of the kickoff; null before it is in. */
  kickoff: CompanyKickoff | null;
  records: ReturnType<typeof withSuccessors>;
  teams: Workspace["teams"];
}

const readBrainCore = async (
  env: Env,
  person: Pick<Identity, "role">
): Promise<BrainCore> => {
  const store = onboardingStore(env);
  const [facts, kickoff, companyTeams, held, claims, drawings] =
    await Promise.all([
      onboardingFacts(env, person),
      store.companyKickoff(),
      store.companyTeams(),
      readBrainRecords(env),
      store.standingClaims(),
      store.standingDrawings(),
    ]);
  // An admin reads the roster whole: every team, roles counted and its
  // leads' roles. Everyone else reads the teams as the admin confirmed
  // them, which are the company's (GRA-1748, the owner on 17 November).
  const roster =
    facts === null ? confirmedTeams(companyTeams) : onboardingTeams(facts);
  const kickoffTeams = await kickoffTeamsOf(kickoff);
  const records = withSuccessors(roster, kickoffTeams, {
    ...held,
    statements: [...held.statements, ...(await claimStatements(claims))],
    workflows: [...held.workflows, ...drawingWorkflows(drawings)],
  });
  return {
    facts,
    kickoff,
    records: withoutGoneKickoffTeams(records, kickoffTeams),
    teams: teamsOf(roster, kickoffTeams, records),
  };
};

/**
 * The brain's teams, what they said and its workflows, as `person` may
 * read them, as `readBrain` reads them: what a step of a chat's thinking
 * may name (agent-thinking.ts). What a team said is a claim five or more
 * of its people made, or none.
 */
export const readThinkingBrain = async (
  env: Env,
  person: Pick<Identity, "role">
): Promise<Pick<Workspace, "teams" | "statements" | "workflows">> => {
  const { records, teams } = await readBrainCore(env, person);
  return {
    teams,
    statements: records.statements,
    workflows: records.workflows,
  };
};

/**
 * The sources the brain's records came from, but Knowledge's transcripts:
 * an admin reads the onboarding's; a member only those the records they
 * read name, so a fact shows where it came from.
 */
const recordSources = async (
  env: Env,
  { facts, kickoff, records, teams }: BrainCore
): Promise<Source[]> => {
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
      ...(kickoff === null ? [] : [kickoffSourceId]),
    ].filter(
      (id) =>
        id === kickoffSourceId || id === rosterSourceId || isTeamInterviews(id)
    )
  );
  const sources =
    facts === null
      ? await sourcesForRecords(env, named)
      : onboardingSources(facts).map(({ source }) => source);
  return [...sources, ...records.sources];
};

/** The brain's workspace, as `person` may read it. */
export const readBrain = async (
  env: Env,
  person: Identity
): Promise<Workspace> => {
  const [core, name, connections, groups, weeks] = await Promise.all([
    readBrainCore(env, person),
    organizationName(env),
    connectionsOf(env, person),
    teamGroupsOf(env),
    onboardingStore(env).interviewWeeks(),
  ]);
  const { facts, kickoff, records, teams } = core;
  const sources = await recordSources(env, core);

  const company: Company = {
    name,
    sector: facts === null ? "" : kickoffSaid(facts.kickoff, "business"),
    people: facts?.view.roster?.people.length ?? 0,
  };

  return {
    company,
    vision: visionOf(kickoff, facts),
    goals: await goalsFor(env, person, records.goals),
    teams,
    // A group names only the teams this reader has; one left with none is
    // not theirs to see.
    teamGroups: groups.flatMap((group) => {
      const teamIds = group.teamIds.filter((id) =>
        teams.some((team) => team.id === id)
      );
      return teamIds.length === 0 ? [] : [{ ...group, teamIds }];
    }),
    interviewWeeks: weeks,
    tools: toolsOf(documentTools(facts, teamsByName(teams)), records.tools),
    sources: sources.map((source) => witnessed(teams, source)),
    statements: records.statements,
    candidates: records.candidates,
    gaps: await brainGaps(env, person, records),
    workflows: records.workflows,
    connections,
  };
};

/**
 * What a picture of a chat's thinking is drawn from, as `person` may read
 * it (`brain.thinking`): the teams, what each said with the team whose
 * source said it, and the workflows with their hours a week. Narrower than
 * `readBrain`: no Knowledge, nothing else of the brain.
 */
export const readThinkingGround = async (
  env: Env,
  person: Pick<Identity, "role">
): Promise<ThinkingGround> => {
  const core = await readBrainCore(env, person);
  const { records, teams } = core;
  const read = await recordSources(env, core);
  const sources = new Map(
    read.map((source) => [source.id, witnessed(teams, source)])
  );
  return {
    teams: teams.map(({ id, name }) => ({ id, name })),
    statements: records.statements.map((statement) => {
      const source = sources.get(statement.sourceId);
      return {
        id: statement.id,
        text: statement.text,
        kind: statement.kind,
        sourceId: statement.sourceId,
        teamId: source?.teamIds?.[0] ?? statement.teamIds[0] ?? "",
        ...(source?.who === undefined ? {} : { who: source.who }),
      };
    }),
    workflows: records.workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      hours: hoursPerWeek(workflow),
    })),
  };
};

/**
 * The company brain over `/rpc`: for anyone signed in. It reads nothing
 * from Knowledge. Adding records is audited, with the records it added;
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

  async work(id: string): Promise<WorkKnowledge> {
    return await withPerson(
      this.#check,
      async (person) =>
        await workKnowledge(
          this.#env,
          person,
          id,
          async () => await readBrain(this.#env, person)
        )
    );
  }

  async askMorePeople(id: string): Promise<WorkKnowledge> {
    return await withPerson(
      this.#check,
      async (person) =>
        await askMorePeople(
          this.#env,
          person,
          id,
          async () => await readBrain(this.#env, person)
        )
    );
  }

  async read(): Promise<Workspace> {
    return await withPerson(
      this.#check,
      async (person) => await readBrain(this.#env, person)
    );
  }

  async thinking(): Promise<ThinkingGround> {
    return await withPerson(
      this.#check,
      async (person) => await readThinkingGround(this.#env, person)
    );
  }

  async goals(): Promise<Goal[]> {
    return await withPerson(this.#check, async (person) => {
      const { goals } = await readBrainRecords(this.#env);
      return await goalsFor(this.#env, person, goals);
    });
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

  /** The brain's teams as `person` reads them. */
  async #teams(person: Identity): Promise<Team[]> {
    const { teams } = await readBrain(this.#env, person);
    return teams;
  }

  async proposeTeamGroups(): Promise<TeamGroup[]> {
    return await withPerson(
      this.#check,
      async (person) =>
        await proposeTeamGroups(
          this.#env,
          person,
          async () => await this.#teams(person)
        )
    );
  }

  async saveTeamGroups(groups: unknown): Promise<TeamGroup[]> {
    return await withPerson(
      this.#check,
      async (person) =>
        await saveTeamGroups(
          this.#env,
          person,
          groups,
          async () => await this.#teams(person)
        )
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
