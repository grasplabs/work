import { actorOf } from "@grasp-os/shared/audit";
import type {
  Candidate,
  Source,
  Statement,
  Tool,
} from "@grasp-os/shared/brain";
import {
  brainRecordErrors,
  brainRecordSchema,
  brainRecordsMaxPerType,
  brainRecordsSchema,
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
import { asc, count, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { brainRecords } from "./db/core/schema.ts";
import { onboardingStore } from "./onboarding/store.ts";

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

/** What each record names, by the type it must be. */
const referencesOf = (
  record: BrainRecord
): { type: BrainRecordType; id: string }[] => {
  switch (record.type) {
    case "source":
    case "candidate": {
      return [];
    }
    case "tool": {
      return [{ type: "source", id: record.sourceId }];
    }
    case "statement": {
      return [
        { type: "source", id: record.sourceId },
        ...record.toolIds.map((id) => ({ type: "tool" as const, id })),
        ...(record.candidateId === undefined
          ? []
          : [{ type: "candidate" as const, id: record.candidateId }]),
        ...(record.followsUp === undefined
          ? []
          : [{ type: "statement" as const, id: record.followsUp }]),
      ];
    }
    default: {
      return [];
    }
  }
};

/**
 * The onboarding's sources the brain has now (brain-rpc.ts names them):
 * the kickoff once it was brought in, the staff list once it was saved.
 */
const onboardingSourcesHeld = async (
  env: Env,
  records: readonly BrainRecord[]
): Promise<Set<string>> => {
  const named = records.some((record) =>
    referencesOf(record).some(
      ({ type, id }) => type === "source" && onboardingSourceIds.has(id)
    )
  );
  if (!named) {
    return new Set();
  }
  const store = onboardingStore(env);
  const [kickoff, view, rosterSavedAt] = await Promise.all([
    store.kickoff(),
    store.view(),
    store.rosterSavedAt(),
  ]);
  return new Set([
    ...(kickoff.transcript === null ? [] : ["src-kickoff"]),
    ...(view.roster === null || rosterSavedAt === null ? [] : ["src-roster"]),
  ]);
};

const types = ["source", "tool", "candidate", "statement"] as const;

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
  onboarding: ReadonlySet<string>
): BrainRecord[] => {
  const before = new Set<string>();
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
        before.has(keyOf(reference)) ||
        held.get(reference.id)?.type === reference.type ||
        (reference.type === "source" && onboarding.has(reference.id));
      if (!known) {
        throw brainRecordErrors.create("brain.record_missing", {
          issues: [`${keyOf(record)}: no ${keyOf(reference)} before it`],
        });
      }
    }
    before.add(keyOf(record));
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
 * Writes `fresh` as `person`, with its audit event, in one batch: none of
 * it when the unique index finds an id taken since it was read.
 */
const writeRecords = async (
  env: Env,
  person: Identity,
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
      actor: actorOf(person),
      action: "brain.records.added",
      target: { type: "brain", id: "playbook" },
      provenance: fresh.map(keyOf),
      detail: { added: fresh.length },
    }),
  ]);
};

/**
 * Adds `input` to the Playbook as `person`, all or none: for admins. A
 * record held already, exactly so, is left as it is.
 */
export const addBrainRecords = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<BrainRecordsAdded> => {
  requireAdmin(person);
  const records = recordsOf(input);
  // GRA-328: a record's free text (a statement's, a gap's question)
  // is canonical Brain storage, so it should pass the knowledge admission gate
  // here, before anything is kept; that gate is not built yet.
  const onboarding = await onboardingSourcesHeld(env, records);
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
      await writeRecords(env, person, fresh);
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

/** The Playbook's records, as the brain reads them, oldest first. */
export interface HeldRecords {
  sources: Source[];
  tools: Tool[];
  candidates: Candidate[];
  statements: Statement[];
}

/** Every record core keeps, in the order they were added. */
export const readBrainRecords = async (env: Env): Promise<HeldRecords> => {
  const held: HeldRecords = {
    sources: [],
    tools: [],
    candidates: [],
    statements: [],
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
      default: {
        break;
      }
    }
  }
  return held;
};
