import { actorOf, auditProvenanceMaxItems } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import type {
  Candidate,
  Gap,
  Source,
  Stakeholder,
  Statement,
  Team,
  TeamCount,
  Step,
  Tool,
  Workflow,
  WorkflowDrawing,
} from "@grasp-os/shared/brain";
import {
  brainGapSubjects,
  brainRecordErrors,
  brainRecordSchema,
  brainRecordsMaxPerCall,
  brainRecordsMaxPerType,
  brainRecordsSchema,
  onboardingIdPrefix,
  onboardingSourceIds,
} from "@grasp-os/shared/brain-records";
import type {
  BrainRecord,
  BrainRecordType,
  BrainRecordsAdded,
} from "@grasp-os/shared/brain-records";
import { issuesOf } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { requireAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, count, eq, gte, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { brainRecords } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// The Playbook's records, as core keeps them (`brain_records`), and adding
// them (`brain.addRecords`). Threat model, and how each is closed (the
// design and its threat note are on GRA-527):
//
// - Someone who shouldn't write the brain: admins alone add records (Grasp
//   staff are admins: they run the interviews), on the live session.
// - A person in a record: a record has no author, transcript or article
//   (`brainRecordSchema` refuses anything it doesn't name); who added it
//   is in the audit log alone.
// - History rewritten: an id, once held, is never written over, whatever
//   type it is sent as (ids are unique across types). A record
//   sent again exactly so is left as it is (a retry); a different one
//   under its id is refused, and nothing in the call is kept.
// - References to nothing: a record's source, tools, candidate and the
//   statement it follows up must be the brain's, already kept or added
//   earlier in the same call, so the brain never shows a fact without its
//   source. The onboarding's sources count only once they exist.
// - A flood: at most `brainRecordsMaxPerCall` records a call, and
//   `brainRecordsMaxPerType` of each type in all, so `brain.read` stays
//   bounded.
// - A change without its record: the records and their audit event are one
//   batch, kept together or not at all.
// - The onboarding's records taken or forged: only the onboarding adds a
//   workflow, a roster team's record or an `onb-` id
//   (`keepOnboardingRecords`, as the system); `brain.addRecords` refuses
//   them (`brainRecordInputSchema`).
// - A purged document left in the brain: the onboarding alone takes its
//   own drawings out (`purgeOnboardingDrawings`, as the system), whole.

/** A record's key across types, as its audit event names it. */
const keyOf = ({ type, id }: { type: string; id: string }): string =>
  `${type}:${id}`;

/** The record as stored: canonical JSON of what the schema parsed. */
const bodyOf = (record: BrainRecord): string => canonicalJson(record);

/** A record core holds: its type and its body as stored. */
interface Held {
  type: string;
  body: string;
}

/** The records core holds among the ids `wanted`, of whatever type. */
const heldOf = async (
  env: Env,
  wanted: readonly string[]
): Promise<Map<string, Held>> => {
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({
      id: brainRecords.id,
      type: brainRecords.type,
      body: brainRecords.body,
    })
    .from(brainRecords)
    // Every id as one bound parameter: D1 binds at most 100 to a
    // statement, and a call can name more ids than that.
    .where(
      sql`${brainRecords.id} IN (SELECT value FROM json_each(${JSON.stringify(wanted)}))`
    );
  return new Map(rows.map(({ id, type, body }) => [id, { type, body }]));
};

/**
 * What a reference must be: a record of a type, or a note (a record of
 * one of `brainGapSubjects`), which is what a gap may be about.
 */
type ReferenceType = BrainRecordType | "note";

const noteTypes: ReadonlySet<string> = new Set(brainGapSubjects);

/** One thing a record names: a team may also be the onboarding's. */
interface Reference {
  type: ReferenceType;
  id: string;
}

const teamsOf = (ids: readonly string[]): Reference[] =>
  ids.map((id) => ({ type: "team", id }));

/** What each record names, by the type it must be. */
const referencesOf = (record: BrainRecord): Reference[] => {
  switch (record.type) {
    case "candidate": {
      return [];
    }
    case "source": {
      return teamsOf(record.teamIds);
    }
    case "team": {
      return [{ type: "source", id: record.sourceId }];
    }
    case "teamCount":
    case "stakeholder": {
      return [
        { type: "source", id: record.sourceId },
        { type: "team", id: record.teamId },
      ];
    }
    case "tool": {
      return [
        { type: "source", id: record.sourceId },
        ...teamsOf(record.teamIds),
      ];
    }
    case "statement": {
      return [
        { type: "source", id: record.sourceId },
        ...teamsOf(record.teamIds),
        ...record.toolIds.map((id) => ({ type: "tool" as const, id })),
        ...(record.candidateId === undefined
          ? []
          : [{ type: "candidate" as const, id: record.candidateId }]),
        ...(record.followsUp === undefined
          ? []
          : [{ type: "statement" as const, id: record.followsUp }]),
      ];
    }
    case "gap": {
      return [
        { type: "source", id: record.sourceId },
        ...record.about.map((id) => ({ type: "note" as const, id })),
      ];
    }
    case "workflow": {
      return [
        { type: "source", id: record.sourceId },
        { type: "team", id: record.teamId },
      ];
    }
    case "workflowVersion": {
      return [
        { type: "source", id: record.sourceId },
        { type: "workflow", id: record.workflowId },
      ];
    }
    default: {
      return [];
    }
  }
};

/** What the onboarding gives the brain now, that a record may name. */
export interface OnboardingHeld {
  /** Its sources: the kickoff once brought in, the staff list once saved. */
  sources: ReadonlySet<string>;
  /**
   * Its teams a value may be for: the roster's, by the ids the admin gave
   * them. Never a kickoff-only team: its id is its place in the reading
   * (`team.kickoff-<n>`), which reading the kickoff again moves.
   */
  teams: ReadonlySet<string>;
}

const nothingOnboarded: OnboardingHeld = {
  sources: new Set(),
  teams: new Set(),
};

/**
 * What the onboarding gives the brain, read (by `read`, brain-rpc.ts) only
 * when a record may name it: a team, or one of its source ids.
 */
const onboardingHeld = async (
  records: readonly BrainRecord[],
  read: () => Promise<OnboardingHeld>
): Promise<OnboardingHeld> => {
  const named = records.some((record) =>
    referencesOf(record).some(
      ({ type, id }) =>
        type === "team" || (type === "source" && onboardingSourceIds.has(id))
    )
  );
  return named ? await read() : nothingOnboarded;
};

const types = [
  "source",
  "tool",
  "candidate",
  "statement",
  "team",
  "teamCount",
  "stakeholder",
  "gap",
  "workflow",
  "workflowVersion",
] as const;

/** Rows one insert writes: four columns each, within D1's 100 bound parameters. */
const rowsPerInsert = 20;

/** The records `input` holds, each once, or why it holds none. */
const recordsOf = (input: unknown): BrainRecord[] => {
  const parsed = brainRecordsSchema.safeParse(input);
  if (!parsed.success) {
    throw brainRecordErrors.create("brain.record_invalid", {
      issues: issuesOf(parsed.error),
    });
  }
  // Ids are the brain's across types: one id is one record.
  const ids = new Set<string>();
  for (const record of parsed.data) {
    if (ids.has(record.id)) {
      throw brainRecordErrors.create("brain.record_invalid", {
        issues: [`${record.id}: sent twice in one call`],
      });
    }
    ids.add(record.id);
  }
  return parsed.data;
};

/** What core holds of every id `records` add or name. */
const heldFor = async (
  env: Env,
  records: readonly BrainRecord[]
): Promise<Map<string, Held>> =>
  await heldOf(env, [
    ...new Set(
      records.flatMap((record) => [
        record.id,
        ...referencesOf(record).map(({ id }) => id),
      ])
    ),
  ]);

/**
 * The records of `records` core doesn't hold yet; refuses one held
 * differently, and one naming what neither core holds nor the call adds
 * before it. Only what came before counts, so references never go round
 * in a circle (two statements following each other up).
 */
const freshOf = (
  records: readonly BrainRecord[],
  held: Map<string, Held>,
  onboarding: OnboardingHeld
): BrainRecord[] => {
  /** The records the call adds before the one being checked, by id. */
  const before = new Map<string, BrainRecordType>();
  /** Whether `reference` is a record of its type, in the call or held. */
  const isRecord = ({ type, id }: Reference): boolean => {
    const found = before.get(id) ?? held.get(id)?.type;
    return (
      found !== undefined &&
      (type === "note" ? noteTypes.has(found) : found === type)
    );
  };
  const fresh: BrainRecord[] = [];
  for (const record of records) {
    const stored = held.get(record.id);
    if (stored === undefined) {
      fresh.push(record);
    } else if (stored.type !== record.type || stored.body !== bodyOf(record)) {
      throw brainRecordErrors.create("brain.record_conflict", {
        issues: [`${keyOf(record)}: held already, differently`],
      });
    }
    for (const reference of referencesOf(record)) {
      const known =
        isRecord(reference) ||
        (reference.type === "source" && onboarding.sources.has(reference.id)) ||
        (reference.type === "team" && onboarding.teams.has(reference.id));
      if (!known) {
        throw brainRecordErrors.create("brain.record_missing", {
          issues: [`${keyOf(record)}: no ${keyOf(reference)} before it`],
        });
      }
    }
    before.set(record.id, record.type);
  }
  return fresh;
};

/**
 * Refuses `fresh` when it would take a type past its cap. Counted before
 * the batch that adds them: calls racing past it overshoot by at most
 * their own records each, which keeps `brain.read` as bounded as the cap
 * means it to be.
 */
const requireRoom = async (
  env: Env,
  fresh: readonly BrainRecord[]
): Promise<void> => {
  const counts = await drizzle(env.DB)
    .select({ type: brainRecords.type, held: count() })
    .from(brainRecords)
    .groupBy(brainRecords.type);
  for (const type of types) {
    const adding = fresh.filter((record) => record.type === type).length;
    const holding = counts.find((row) => row.type === type)?.held ?? 0;
    if (adding > 0 && holding + adding > brainRecordsMaxPerType[type]) {
      throw brainRecordErrors.create("brain.records_full");
    }
  }
};

/** Whether `error`, or what it wraps, is `brain_records` refusing an id it holds. */
const isTakenId = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("UNIQUE constraint failed: brain_records.id") ||
    isTakenId(error.cause));

/** How often a call writes after racing another for its ids. */
const maxWriteAttempts = 3;

/**
 * Writes `fresh` as `actor`, with its audit event, in one batch: none of
 * it when the unique index finds an id taken since it was read.
 */
const writeRecords = async (
  env: Env,
  actor: AuditActor,
  fresh: readonly BrainRecord[]
): Promise<void> => {
  await requireRoom(env, fresh);
  const db = drizzle(env.DB);
  const addedAt = new Date();
  const row = (record: BrainRecord) => ({
    type: record.type,
    id: record.id,
    body: bodyOf(record),
    addedAt,
  });
  // Four columns a row: a statement inserts at most `rowsPerInsert` rows,
  // within D1's 100 bound parameters.
  const [first, ...more] = Array.from(
    { length: Math.ceil(fresh.length / rowsPerInsert) },
    (_, index) =>
      fresh.slice(index * rowsPerInsert, (index + 1) * rowsPerInsert).map(row)
  );
  if (first === undefined) {
    return;
  }
  const insert = (rows: ReturnType<typeof row>[]) =>
    db.insert(brainRecords).values(rows);
  await auditedBatch(env, db, [
    insert(first),
    ...more.map(insert),
    outboxed(db, {
      actor,
      action: "brain.records.added",
      target: { type: "brain", id: "playbook" },
      provenance: fresh.map(keyOf),
      detail: { added: fresh.length },
    }),
  ]);
};

/**
 * Keeps `records` as `actor`, all or none, beside what `onboarding` gives
 * the brain. A record held already, exactly so, is left as it is.
 */
const keepRecords = async (
  env: Env,
  actor: AuditActor,
  records: readonly BrainRecord[],
  onboarding: OnboardingHeld
): Promise<BrainRecordsAdded> => {
  // Another call can add some of these ids between the read and the
  // write: the unique index then refuses the whole batch, and what is
  // still fresh is read again and written once more.
  for (let attempt = 1; ; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- read again after a race
    const fresh = freshOf(records, await heldFor(env, records), onboarding);
    const unchanged = records.length - fresh.length;
    if (fresh.length === 0) {
      return { added: 0, unchanged };
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- write again after a race
      await writeRecords(env, actor, fresh);
      return { added: fresh.length, unchanged };
    } catch (error) {
      if (!isTakenId(error) || attempt === maxWriteAttempts) {
        throw isTakenId(error)
          ? brainRecordErrors.create("brain.record_conflict")
          : error;
      }
    }
  }
};

/**
 * Adds `input` to the Playbook as `person`, all or none: for admins. A
 * record held already, exactly so, is left as it is. `onboarding` reads
 * what the onboarding gives the brain, when a record names it.
 */
export const addBrainRecords = async (
  env: Env,
  person: Identity,
  input: unknown,
  onboarding: () => Promise<OnboardingHeld>
): Promise<BrainRecordsAdded> => {
  requireAdmin(person);
  const records = recordsOf(input);
  return await keepRecords(
    env,
    actorOf(person),
    records,
    await onboardingHeld(records, onboarding)
  );
};

/**
 * Keeps the onboarding's own records (GRA-367), as the system: its team
 * records, statements and drawn workflows, each type only it adds. They
 * may name `held`, the onboarding's sources and teams. In calls of at
 * most `brainRecordsMaxPerCall`, in order, so a record finds what an
 * earlier call kept; each call all or none, and a retry keeps what is
 * left.
 */
export const keepOnboardingRecords = async (
  env: Env,
  records: readonly BrainRecord[],
  held: OnboardingHeld
): Promise<BrainRecordsAdded> => {
  const kept: BrainRecordsAdded = { added: 0, unchanged: 0 };
  for (let at = 0; at < records.length; at += brainRecordsMaxPerCall) {
    // oxlint-disable-next-line no-await-in-loop -- each call names what the one before kept
    const { added, unchanged } = await keepRecords(
      env,
      { type: "system" },
      records.slice(at, at + brainRecordsMaxPerCall),
      held
    );
    kept.added += added;
    kept.unchanged += unchanged;
  }
  return kept;
};

/**
 * Takes out of the brain, for good, every drawing the onboarding gave it
 * from `since` on: what may have been drawn with a document's reading
 * that a Knowledge purge reached (onboarding/documents.ts). A drawing is
 * a version of its workflow; the workflow stays, and is drawn again.
 * Nothing else is taken out, and nothing written over. One batch with its
 * audit event, which names the records by id and counts them, never what
 * they said. Returns the ids taken out.
 */
export const purgeOnboardingDrawings = async (
  env: Env,
  since: Date
): Promise<string[]> => {
  const db = drizzle(env.DB);
  const held = await db
    .select({ id: brainRecords.id, type: brainRecords.type })
    .from(brainRecords)
    .where(
      and(
        eq(brainRecords.type, "workflowVersion"),
        like(brainRecords.id, `${onboardingIdPrefix}%`),
        gte(brainRecords.addedAt, since)
      )
    );
  if (held.length === 0) {
    return [];
  }
  const gone = held.map(({ id }) => id);
  await auditedBatch(env, db, [
    db.delete(brainRecords).where(inList(brainRecords.id, gone)),
    outboxed(db, {
      actor: { type: "system" },
      action: "brain.records.purged",
      target: { type: "brain", id: "playbook" },
      provenance: held.slice(0, auditProvenanceMaxItems).map(keyOf),
      detail: { purged: held.length },
    }),
  ]);
  return gone;
};

/** A dated value of a team, by the team it is for. */
interface ForTeam<T> {
  teamId: string;
  value: T;
}

/** The Playbook's records, as the brain reads them, oldest first. */
export interface HeldRecords {
  sources: Source[];
  tools: Tool[];
  candidates: Candidate[];
  statements: Statement[];
  /** Its team records, each with the counts and stakeholders added for it. */
  teams: Team[];
  /** Counts added for teams that aren't records: the onboarding's. */
  teamCounts: ForTeam<TeamCount>[];
  /** Stakeholders added for teams that aren't records: the onboarding's. */
  stakeholders: ForTeam<Stakeholder>[];
  gaps: GapRecord[];
  /** Its workflows, each with its drawings, the newest its baseline. */
  workflows: Workflow[];
  /** Drawings of workflows, before they join theirs. */
  drawings: ForWorkflow[];
}

/** A drawing, by the workflow it is of. */
interface ForWorkflow {
  workflowId: string;
  value: WorkflowDrawing;
}

/** A gap as added, before what became of it. */
export type GapRecord = Omit<
  Gap,
  "askedAt" | "closedAt" | "answer" | "answeredBy"
>;

/** Puts `record` where the brain reads it, as the brain's own type. */
const collect = (held: HeldRecords, record: BrainRecord): void => {
  switch (record.type) {
    case "source": {
      const { type: _source, ...source } = record;
      held.sources.push(source);
      break;
    }
    case "tool": {
      const { type: _tool, ...tool } = record;
      held.tools.push(tool);
      break;
    }
    case "candidate": {
      const { type: _candidate, ...candidate } = record;
      held.candidates.push(candidate);
      break;
    }
    case "statement": {
      const { type: _statement, ...statement } = record;
      held.statements.push(statement);
      break;
    }
    case "team": {
      const { id, name, sourceId } = record;
      held.teams.push({ id, name, sourceId, counts: [], stakeholders: [] });
      break;
    }
    case "teamCount": {
      const { teamId, sourceId, date, people, roles } = record;
      held.teamCounts.push({
        teamId,
        value: {
          sourceId,
          date,
          people,
          ...(roles === undefined ? {} : { roles }),
        },
      });
      break;
    }
    case "stakeholder": {
      const { teamId, sourceId, date, role } = record;
      held.stakeholders.push({ teamId, value: { sourceId, date, role } });
      break;
    }
    case "gap": {
      const { type: _gap, ...gap } = record;
      held.gaps.push(gap);
      break;
    }
    case "workflow": {
      const { id, name, local, teamId, status } = record;
      held.workflows.push({
        id,
        name,
        ...(local === undefined ? {} : { local }),
        teamId,
        status,
        baseline: { steps: [] },
        drawings: [],
      });
      break;
    }
    case "workflowVersion": {
      const { type: _version, workflowId, ...value } = record;
      held.drawings.push({ workflowId, value });
      break;
    }
    default: {
      break;
    }
  }
};

/** Oldest date first: a value added later for an earlier day goes before. */
const byDate = <T extends { date: string }>(values: T[]): T[] =>
  // A stable sort: values of one day keep the order they were added in,
  // so the one added last counts, as the brain reads a history.
  values.toSorted((a, b) => a.date.localeCompare(b.date));

/**
 * Puts `team`'s counts and stakeholders in date order, which is how the
 * brain reads them (the last one counts), whatever order they came in.
 */
export const datedInOrder = (team: Team): void => {
  team.counts = byDate(team.counts);
  team.stakeholders = byDate(team.stakeholders);
};

/** The steps of a drawing, as a workflow's baseline. */
const stepsOf = ({ steps }: WorkflowDrawing): Step[] =>
  steps.map(({ text, who, tool, minutes }) => ({
    text,
    ...(who === "" ? {} : { who }),
    ...(tool === "" ? {} : { tool }),
    ...(minutes === null ? {} : { minutes }),
  }));

/**
 * Gives each workflow its drawings, oldest first, and the newest as its
 * baseline: a drawing for a workflow that isn't held is left out.
 */
const withDrawings = (held: HeldRecords): void => {
  const workflows = new Map(held.workflows.map((each) => [each.id, each]));
  for (const { workflowId, value } of held.drawings) {
    workflows.get(workflowId)?.drawings?.push(value);
  }
  for (const workflow of held.workflows) {
    const drawings = byDate(workflow.drawings ?? []);
    const newest = drawings.at(-1);
    workflow.drawings = drawings;
    workflow.baseline = { steps: newest === undefined ? [] : stepsOf(newest) };
  }
  held.drawings = [];
};

/** Every record core keeps, in the order they were added. */
export const readBrainRecords = async (env: Env): Promise<HeldRecords> => {
  const held: HeldRecords = {
    sources: [],
    tools: [],
    candidates: [],
    statements: [],
    teams: [],
    teamCounts: [],
    stakeholders: [],
    gaps: [],
    workflows: [],
    drawings: [],
  };
  const rows = await drizzle(env.DB)
    .select({ body: brainRecords.body })
    .from(brainRecords)
    .orderBy(asc(brainRecords.position));
  for (const { body } of rows) {
    let record: BrainRecord;
    try {
      record = brainRecordSchema.parse(JSON.parse(body));
    } catch (error) {
      // Written through the same schema: a row it can't read is left out
      // rather than failing the brain for everyone.
      log.error("brain.record_unreadable", errorFields(error));
      continue;
    }
    collect(held, record);
  }
  // A team's counts and stakeholders go with it when it is a record; the
  // rest are for the onboarding's teams, which brain-rpc.ts gives them to.
  const teams = new Map(held.teams.map((team) => [team.id, team]));
  held.teamCounts = held.teamCounts.filter(({ teamId, value }) => {
    teams.get(teamId)?.counts.push(value);
    return !teams.has(teamId);
  });
  held.stakeholders = held.stakeholders.filter(({ teamId, value }) => {
    teams.get(teamId)?.stakeholders.push(value);
    return !teams.has(teamId);
  });
  for (const team of held.teams) {
    datedInOrder(team);
  }
  withDrawings(held);
  return held;
};
