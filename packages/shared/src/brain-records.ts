import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// The Playbook's records as core keeps them (core's brain-records.ts), and
// what `brain.addRecords` takes: where a fact came from (`source`), the
// tools a team uses (`tool`), processes that might be worth fixing
// (`candidate`), what was said about them (`statement`), the teams it
// was said for (`team`, with their sizes, `teamCount`, and the role
// interviewed for them, `stakeholder`), and what isn't known yet, with who
// can answer it (`gap`). Shaped as the
// prototype's (`grasplabs/prototype`, packages/grasp/src/data/types.ts at
// `ddd235d`), so `brain.read` serves them as the brain's own types.
//
// A record names only what the brain holds or its call adds before it:
// its source, tools, candidate, the statement it follows up, the records
// a gap is about, and its teams (a team record, or a team the onboarding
// gives the brain, once it exists).
// A record is never written over: once added, its id holds it for good,
// whatever type it is sent as.
// A statement that changes is followed up by a new one (`followsUp`); a
// team's size or stakeholder by a new dated value, the newest counting. A
// gap is asked about, answered or closed once each (`brain.askAboutGap`,
// `answerGap`, `closeGap`), never reopened.
// Nothing in a record names a person: a source's `who` is a role ("Head
// of finance"), never a name, and there is no transcript or article, so
// no interview's words reach the brain. Titles, names and a statement's
// `text` are agreed facts, written as the brain says them, never quotes.
// Every member reads them. Who added a record is in the audit log alone;
// only a gap's answer carries the name of who gave it, as they gave it.

/** Most records one `brain.addRecords` call adds, each named in its audit event. */
export const brainRecordsMaxPerCall = 50;

/** Most records of each type core keeps, so `brain.read` stays bounded. */
export const brainRecordsMaxPerType = {
  source: 500,
  tool: 500,
  candidate: 500,
  statement: 2000,
  team: 500,
  teamCount: 2000,
  stakeholder: 2000,
  gap: 1000,
} as const;

/** Longest a gap's question, or its answer, may be. */
export const brainGapTextMaxLength = 2000;

/** Longest a statement's text may be. */
export const brainStatementMaxLength = 2000;

/** Most teams, tools or other ids one record lists. */
const listMax = 50;

/**
 * Ids the brain gives the onboarding's sources (core's brain-rpc.ts): a
 * record can name them as its source, only once each exists (the kickoff
 * brought in, the staff list saved), and never take them as its own id.
 */
export const onboardingSourceIds: ReadonlySet<string> = new Set([
  "src-kickoff",
  "src-roster",
]);

/** A record's id, chosen by whoever adds it: letters, digits, `-` and `_`. */
export const brainRecordIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/u, "Use letters, digits, - and _ only.");

const ids = z.array(brainRecordIdSchema).max(listMax).default([]);

/**
 * A team's id: a team record's, or one the onboarding gives the brain
 * (`team-<id>` for the roster's, `team.kickoff-<n>` for the kickoff's).
 */
export const brainTeamIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,80}$/u, "That isn't a team's id.");

const teamIds = z.array(brainTeamIdSchema).max(listMax).default([]);
const label = z.string().trim().min(1).max(200);
const day = z.iso.date();

/** Statement kinds that hurt, and so may say how much. */
export const painfulKinds: ReadonlySet<string> = new Set([
  "blocker",
  "timeSink",
  "handover",
]);

/**
 * A record's own id: never one of the onboarding's source ids, which a
 * record may name but not take, whatever its type.
 */
const ownIdSchema = brainRecordIdSchema.refine(
  (id) => !onboardingSourceIds.has(id),
  "That id is the onboarding's."
);

const sourceRecordSchema = z.strictObject({
  type: z.literal("source"),
  id: ownIdSchema,
  kind: z.enum(["interview", "chat", "document", "import", "runLog"]),
  /** What it was, in a few words: never a person's name. */
  title: label,
  date: day,
  /** Who gave it, as a role ("Head of finance"), never a name. */
  who: label.optional(),
  /** How it was collected: "Live, 45 minutes", "Chat link". */
  how: label.optional(),
  step: z.literal([1, 2, 3, 4, 5, 6]).optional(),
  interviewee: z.enum(["stakeholder", "employee"]).optional(),
  /** The teams this source speaks for. */
  teamIds,
});

const toolRecordSchema = z.strictObject({
  type: z.literal("tool"),
  id: ownIdSchema,
  name: label,
  teamIds,
  sourceId: brainRecordIdSchema,
  ai: z.enum(["tool", "builtIn", "none"]).optional(),
});

const candidateRecordSchema = z.strictObject({
  type: z.literal("candidate"),
  id: ownIdSchema,
  name: label,
  // No `workflowId` yet: core keeps no drawn workflows to check one
  // against, so a candidate names none until it does.
});

const statementRecordSchema = z
  .strictObject({
    type: z.literal("statement"),
    id: ownIdSchema,
    kind: z.enum([
      "goal",
      "blocker",
      "timeSink",
      "handover",
      "tool",
      "rule",
      "wish",
    ]),
    /**
     * The fact as the team agreed it, in the brain's words: never a quote,
     * and never naming a person.
     */
    text: z.string().trim().min(1).max(brainStatementMaxLength),
    sourceId: brainRecordIdSchema,
    teamIds,
    toolIds: ids,
    /** The candidate process it is about. */
    candidateId: brainRecordIdSchema.optional(),
    /** The earlier statement this one follows up; that one is never edited. */
    followsUp: brainRecordIdSchema.optional(),
    /** How much it hurts, as the team said it. */
    pain: z.enum(["low", "medium", "high"]).optional(),
  })
  .refine(({ kind, pain }) => pain === undefined || painfulKinds.has(kind), {
    message: "Only blockers, time sinks and handovers hurt.",
    path: ["pain"],
  })
  .refine(({ id, followsUp }) => followsUp !== id, {
    message: "A statement can't follow itself up.",
    path: ["followsUp"],
  });

const teamRecordSchema = z.strictObject({
  type: z.literal("team"),
  // `team-` is the onboarding's (`team-<id>` for a roster team, now or
  // later): a team record's id never takes it, so one id is one team.
  id: brainRecordIdSchema.refine(
    (id) => !id.startsWith("team-"),
    "Ids starting with team- are the onboarding's."
  ),
  name: label,
  /** Where the team was first found. */
  sourceId: brainRecordIdSchema,
});

/**
 * A team's size and roles, as one source gave them. Its team may be one
 * the onboarding gives the brain (`team-<id>`): it shows with that team
 * for whoever reads it, and with none for anyone else.
 */
const teamCountRecordSchema = z.strictObject({
  type: z.literal("teamCount"),
  id: brainRecordIdSchema,
  teamId: brainTeamIdSchema,
  sourceId: brainRecordIdSchema,
  date: day,
  people: z.int().min(0).max(1_000_000).nullable(),
  /** How many people hold each role, never who. */
  roles: z
    .array(
      z.strictObject({
        name: label,
        people: z.int().min(0).max(1_000_000).nullable(),
      })
    )
    .max(listMax)
    .optional(),
});

/** The role interviewed for a team, as one source named it: never the person. */
const stakeholderRecordSchema = z.strictObject({
  type: z.literal("stakeholder"),
  id: brainRecordIdSchema,
  teamId: brainTeamIdSchema,
  sourceId: brainRecordIdSchema,
  date: day,
  role: label,
});

const gapRecordSchema = z.strictObject({
  type: z.literal("gap"),
  id: brainRecordIdSchema,
  question: z.string().trim().min(1).max(brainGapTextMaxLength),
  /** The role that can answer it. */
  owner: label,
  /** Where it was noticed. */
  sourceId: brainRecordIdSchema,
  /** The brain's records it is about: statements, tools, candidates, teams. */
  about: ids,
});

/** One record `brain.addRecords` takes, on `type`. */
export const brainRecordSchema = z.discriminatedUnion("type", [
  sourceRecordSchema,
  toolRecordSchema,
  candidateRecordSchema,
  statementRecordSchema,
  teamRecordSchema,
  teamCountRecordSchema,
  stakeholderRecordSchema,
  gapRecordSchema,
]);
export type BrainRecordInput = z.input<typeof brainRecordSchema>;
export type BrainRecord = z.infer<typeof brainRecordSchema>;
export type BrainRecordType = BrainRecord["type"];

/** What one `brain.addRecords` call takes. */
export const brainRecordsSchema = z
  .array(brainRecordSchema)
  .min(1)
  .max(brainRecordsMaxPerCall);

/** What a `brain.addRecords` call kept. */
export interface BrainRecordsAdded {
  /** Records it added. */
  added: number;
  /** Records it was sent that core held already, exactly so: a retry. */
  unchanged: number;
}

/** Why records weren't added; nothing in the call was. */
export const brainRecordErrors = defineErrorFamily({
  "brain.record_invalid":
    "That isn't a record the brain takes. Records name roles, never people, and say agreed facts, never quotes.",
  "brain.record_conflict":
    "A different record already has that id. Records are never written over: add a new one.",
  "brain.record_missing":
    "That record names a source, team, tool, candidate or statement the brain doesn't have.",
  "brain.records_full": "The brain holds as many of those records as it takes.",
});

/** An answer to a gap, as `brain.answerGap` takes it. */
export const brainGapAnswerSchema = z
  .string()
  .trim()
  .min(1)
  .max(brainGapTextMaxLength);

/** Why a gap couldn't be asked about, answered or closed. */
export const brainGapErrors = defineErrorFamily({
  "brain.gap_not_found": "The brain has no such question.",
  "brain.gap_closed": "That question is closed already.",
  "brain.gap_invalid": "That isn't an answer the brain takes.",
});
