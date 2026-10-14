import type {
  BrainApi,
  Company,
  Connection,
  Source,
  Stakeholder,
  Statement,
  StatementKind,
  Step,
  Team,
  TeamCount,
  Vision,
  Workflow,
  Workspace,
} from "@grasp-os/shared/brain";
import type { CatalogSource } from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { KickoffView } from "@grasp-os/shared/kickoff";
import {
  knowledgeErrors,
  recordPageMaxLimit,
} from "@grasp-os/shared/knowledge";
import type { RecordSummary } from "@grasp-os/shared/knowledge";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { organizationId } from "./auth/auth.ts";
import { offeredEntries, personOf } from "./connections.ts";
import { organizations } from "./db/core/schema.ts";
import type { Reader } from "./knowledge/access.ts";
import { getRecord, listRecords } from "./knowledge/records.ts";
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
// | teams              | the roster and the kickoff's teams (admins), and the     |
// |                    | Playbook's `team` records (anyone who reads it)          |
// | sources            | the kickoff and the roster (admins), the Playbook's      |
// |                    | `source` records                                         |
// | statements         | the Playbook's `statement` records                       |
// | workflows          | the Playbook's `workflow` records (the workflow map)     |
// | connections        | the catalog's offered entries and the person's           |
// |                    | connections                                              |
// | goals, tools,      | nothing holds them yet: empty                            |
// | candidates, gaps,  |                                                          |
// | landscape,         |                                                          |
// | policies           |                                                          |
//
// The onboarding (who works where, the kickoff) is the admin's: its own
// RPC shows the roster to admins alone, and the kickoff to Grasp's staff,
// who are admins. The kickoff is the company's sponsor speaking for the
// company, so its reading reaches the company's admins here too, never its
// transcript. Everyone else gets the brain without them. The Playbook is
// read as Knowledge reads it for the person (`listRecords` with the
// person as the reader): a collection they can't read gives nothing, and
// every page read is in the audit log, as any read of it is. No
// interview's words reach the brain: the onboarding keeps them for staff
// alone, so sources carry no transcript.

/** The collection the Intake and the workflow map keep their records in. */
const playbook = "playbook";

/**
 * The most records of one type read from the Playbook, in pages of
 * `recordPageMaxLimit` (20), each one read and one audit event: at most
 * 25 reads per type. Past it the first in path order are kept and the
 * rest left out; a Playbook that large needs a brain read in parts,
 * which nothing asks for yet.
 */
const brainRecordsMax = 500;

/**
 * The most designed workflows whose drawn version is read for their
 * baseline: one read each. Past it a designed workflow comes without its
 * baseline's steps.
 */
const baselinesMax = 50;

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
  playbookTeam: (documentId: string) => `team.playbook-${documentId}`,
  source: (documentId: string) => `src-${documentId}`,
  statement: (documentId: string) => `st-${documentId}`,
  workflow: (documentId: string) => `wf-${documentId}`,
};

/** The day of an ISO 8601 moment: `YYYY-MM-DD`. */
const dayOf = (iso: string): string => iso.slice(0, 10);

/** A team's name as two sources can both mean it: trimmed, any case. */
const nameKey = (name: string): string => name.trim().toLowerCase();

/**
 * The Intake's statement tags (apps/core/blueprints/intake records.json)
 * as the brain's kinds. A statement has one kind and up to six tags: its
 * first tag the brain knows is its kind. The Intake keeps tags in this
 * order whatever order they were picked in, so a goal wins over a
 * blocker, and a blocker over a rule. The brain's `wish` has no tag yet,
 * so no statement is one.
 */
const kindOfTag: Record<string, StatementKind> = {
  goal: "goal",
  blocker: "blocker",
  time_sink: "timeSink",
  handover: "handover",
  tool: "tool",
  rule: "rule",
};

const sourceRecordSchema = z.object({
  title: z.string(),
  medium: z.enum(["interview", "chat", "document", "other"]),
  date: z.string(),
  from: z.string().optional(),
  guest: z.boolean().optional(),
});

const statementRecordSchema = z.object({
  title: z.string(),
  source: z.string(),
  tags: z.array(z.string()),
});

const workflowRecordSchema = z.object({
  state: z.enum(["drawn", "designed"]),
  team: z.string().optional(),
  steps: z.array(z.object({ tool: z.string().optional() })).default([]),
  drawnVersion: z.int().optional(),
});

/**
 * A Playbook source as the brain's: its medium as the kind (`other`, the
 * one the brain has no kind for, as a document), who gave it as `from`
 * says, and a guest's chat as one held by link. The Intake saves what
 * people said about their work, which is the brain's step 2.
 */
const sourceOf = (
  record: RecordSummary,
  fields: z.output<typeof sourceRecordSchema>
): Source => ({
  id: ids.source(record.id),
  kind: fields.medium === "other" ? "document" : fields.medium,
  title: fields.title,
  date: fields.date,
  ...(fields.from === undefined ? {} : { who: fields.from }),
  ...(fields.guest === true ? { how: "Chat link" } : {}),
  step: 2,
});

/** Every record of `type` in the Playbook `reader` may read, up to the cap. */
const playbookRecords = async (
  env: Env,
  reader: Reader,
  type: string
): Promise<RecordSummary[]> => {
  const all: RecordSummary[] = [];
  let after: string | undefined;
  while (all.length < brainRecordsMax) {
    let page: Awaited<ReturnType<typeof listRecords>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each page starts after the last
      page = await listRecords(env, reader, playbook, {
        ...(after === undefined ? {} : { after }),
        limit: Math.min(recordPageMaxLimit, brainRecordsMax - all.length),
        type,
      });
    } catch (error) {
      // No Playbook yet (no Intake or map installed), or one this
      // person can't read: nothing from it.
      if (knowledgeErrors.codeOf(error) === "knowledge.not_found") {
        return all;
      }
      throw error;
    }
    all.push(...page.records);
    if (page.next === null) {
      break;
    }
    after = page.next;
  }
  return all;
};

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

/** What the kickoff said about `field`, or the sponsor answered; empty if neither. */
const kickoffSaid = (
  kickoff: KickoffView,
  field: "business" | "goals" | "pain"
): string =>
  kickoff.reading?.fields[field]?.text ?? kickoff.answers[field] ?? "";

/** The onboarding's sources: the kickoff, and who works where. */
const onboardingSources = (facts: OnboardingFacts | null): Source[] => {
  const kickoffAt = facts?.kickoff.transcript?.at;
  return [
    ...(kickoffAt === undefined
      ? []
      : [
          {
            id: kickoffSourceId,
            kind: "interview",
            title: "Kickoff",
            date: dayOf(kickoffAt),
            step: 1,
          } satisfies Source,
        ]),
    // The roster is the list of who works where the admin gave: as the
    // brain reads a directory, the source of the teams' sizes and roles.
    ...(facts === null ||
    facts.view.roster === null ||
    facts.rosterSavedAt === null
      ? []
      : [
          {
            id: rosterSourceId,
            kind: "import",
            connection: "directory",
            title: "Staff list",
            date: dayOf(facts.rosterSavedAt),
            step: 2,
          } satisfies Source,
        ]),
  ];
};

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
 * connections to entries the catalog doesn't list (a toolkit it no longer
 * lists, say). A native provider is connected directly; a toolkit through
 * Composio. A connection matches the tool names that are its name.
 */
const connectionsOf = async (
  env: Env,
  person: Identity
): Promise<Connection[]> => {
  const [entries, listed] = await Promise.all([
    offeredEntries(env),
    personOf(env, person).then(
      async (connecting) => await env.CONNECT.listConnections(connecting)
    ),
  ]);
  const active = new Set(
    listed
      .filter(({ status }) => status === "active")
      .map(({ source, provider }) => entryKey(source, provider))
  );
  const offered = entries.map(({ source, id, name }): Connection => ({
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

/** A workflow record's steps as the brain reads them: the tools they use. */
const stepsOf = (steps: { tool?: string }[]): Step[] =>
  steps.map(({ tool }) => (tool === undefined ? {} : { tool }));

/**
 * The Playbook's workflows, as the workflow map keeps them: a drawn one's
 * steps are its baseline; a designed one's are its target, and its
 * baseline the version last drawn (`drawnVersion`), read for up to
 * `baselinesMax` of them. A workflow's team is its team record, by path.
 * Nothing says yet whether one is being tested or runs: those are drawn
 * or designed here.
 */
const workflowsOf = async (
  env: Env,
  reader: Reader,
  records: RecordSummary[],
  teamOfPath: Map<string, string>
): Promise<Workflow[]> => {
  let baselinesLeft = baselinesMax;
  const workflows: Workflow[] = [];
  for (const record of records) {
    const fields = workflowRecordSchema.safeParse(record.record);
    if (!fields.success) {
      continue;
    }
    const { state, team, steps, drawnVersion } = fields.data;
    const teamId = team === undefined ? undefined : teamOfPath.get(team);
    let baseline: Step[] = state === "drawn" ? stepsOf(steps) : [];
    if (
      state === "designed" &&
      drawnVersion !== undefined &&
      baselinesLeft > 0
    ) {
      baselinesLeft -= 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- bounded by baselinesMax
        const drawn = await getRecord(env, reader, record.id, drawnVersion);
        const parsed = workflowRecordSchema.safeParse(drawn.record);
        baseline = parsed.success ? stepsOf(parsed.data.steps) : [];
      } catch (error) {
        // A version that no longer fits its type: no baseline.
        if (!isExpectedError(error)) {
          throw error;
        }
      }
    }
    workflows.push({
      id: ids.workflow(record.id),
      name: record.title,
      ...(teamId === undefined ? {} : { teamId }),
      status: state,
      baseline: { steps: baseline },
      ...(state === "designed" ? { target: { steps: stepsOf(steps) } } : {}),
    });
  }
  return workflows;
};

/** The brain's workspace, as `person` may read it. */
export const readBrain = async (
  env: Env,
  person: Identity
): Promise<Workspace> => {
  const reader: Reader = { type: "person", person };
  const [
    facts,
    name,
    connections,
    sourceRecords,
    statementRecords,
    teamRecords,
    workflowRecords,
  ] = await Promise.all([
    onboardingFacts(env, person),
    organizationName(env),
    connectionsOf(env, person),
    playbookRecords(env, reader, "source"),
    playbookRecords(env, reader, "statement"),
    playbookRecords(env, reader, "team"),
    playbookRecords(env, reader, "workflow"),
  ]);

  const teams = onboardingTeams(facts);
  // A Playbook team is the roster's or the kickoff's of its name, or a
  // team of its own, found in no source.
  const teamByName = new Map(teams.map((team) => [nameKey(team.name), team]));
  const teamOfPath = new Map<string, string>();
  for (const record of teamRecords) {
    const known = teamByName.get(nameKey(record.title));
    if (known === undefined) {
      const team: Team = {
        id: ids.playbookTeam(record.id),
        name: record.title,
        sourceId: "",
        counts: [],
        stakeholders: [],
      };
      teams.push(team);
      teamByName.set(nameKey(record.title), team);
      teamOfPath.set(record.path, team.id);
    } else {
      teamOfPath.set(record.path, known.id);
    }
  }

  const sources = onboardingSources(facts);
  const sourceOfPath = new Map<string, string>();
  for (const record of sourceRecords) {
    const fields = sourceRecordSchema.safeParse(record.record);
    if (fields.success) {
      const source = sourceOf(record, fields.data);
      sources.push(source);
      sourceOfPath.set(record.path, source.id);
    }
  }

  const statements: Statement[] = [];
  for (const record of statementRecords) {
    const fields = statementRecordSchema.safeParse(record.record);
    const kind = fields.success
      ? fields.data.tags.map((tag) => kindOfTag[tag]).find(Boolean)
      : undefined;
    // A statement names its source by path: one that wasn't read (past
    // the cap) leaves it out, as the brain finds a statement by its source.
    const sourceId = fields.success
      ? sourceOfPath.get(fields.data.source)
      : undefined;
    if (fields.success && kind !== undefined && sourceId !== undefined) {
      statements.push({
        id: ids.statement(record.id),
        kind,
        text: fields.data.title,
        sourceId,
        // The Intake ties a statement to no team or tool yet.
        teamIds: [],
        toolIds: [],
      });
    }
  }

  const company: Company = {
    name,
    sector: facts === null ? "" : kickoffSaid(facts.kickoff, "business"),
    people: facts?.view.roster?.people.length ?? 0,
  };

  return {
    company,
    vision: visionOf(facts),
    goals: [],
    teams,
    tools: [],
    sources,
    statements,
    candidates: [],
    gaps: [],
    workflows: await workflowsOf(env, reader, workflowRecords, teamOfPath),
    connections,
    landscape: [],
    policies: [],
  };
};

/**
 * The company brain over `/rpc`: for anyone signed in who reads
 * Knowledge, which is everyone the session's full access lets in.
 * Not audited itself: the Playbook's reads it makes are, as any are.
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
}
