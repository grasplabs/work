import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { appIdSchema, workflowIdSchema } from "./ids.ts";

// The brain's records as core keeps them (core's brain-records.ts), and
// what `brain.addRecords` takes: where a fact came from (`source`), the
// tools a team uses (`tool`), processes that might be worth fixing
// (`candidate`), what was said about them (`statement`), the teams it
// was said for (`team`, with their sizes, `teamCount`, and the role
// interviewed for them, `stakeholder`), and what isn't known yet, with who
// can answer it (`gap`). Shaped as the
// prototype's (`grasplabs/prototype`, packages/grasp/src/data/types.ts at
// `ddd235d`), so `brain.readWorkspace` serves them as the brain's own types.
//
// A record names only what the brain holds or its call adds before it:
// its source, tools, candidate, the statement it follows up, the records
// a gap is about, and its teams (a team record, or a roster team, once
// it exists).
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
//
// The board's goals are records too (GRA-516): a goal (`goal`, its first
// wording), each later wording of it (`goalVersion`, the newest counting),
// and each time one of the company's workflows was linked to it or taken
// off (`goalLink`, the newest for an App's workflow counting).
//
// The onboarding adds records of its own (GRA-367): each roster team as a
// team record (`team-<id>`), the statements its people agreed to, and each
// piece of work as drawn (`workflow`, and a `workflowVersion` for each
// drawing). It owns them: their ids start with `onb-` (or are a roster
// team's), and nobody else adds a workflow or takes such an id.

/** Most records one `brain.addRecords` call adds, each named in its audit event. */
export const brainRecordsMaxPerCall = 50;

/** Most records of each type core keeps, so `brain.readWorkspace` stays bounded. */
export const brainRecordsMaxPerType = {
  source: 500,
  tool: 500,
  candidate: 500,
  statement: 2000,
  team: 500,
  teamCount: 2000,
  stakeholder: 2000,
  gap: 1000,
  workflow: 500,
  workflowVersion: 5000,
  goal: 200,
  goalVersion: 2000,
  goalLink: 5000,
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

/** What the onboarding's own record ids start with: nobody else's do. */
export const onboardingIdPrefix = "onb-";

/** A record's id, chosen by whoever adds it: letters, digits, `-` and `_`. */
export const brainRecordIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/u, "Use letters, digits, - and _ only.");

const ids = z.array(brainRecordIdSchema).max(listMax).default([]);

/**
 * A team's id: a team record's, or a roster team's (`team-<id>`). A
 * kickoff-only team (`team.kickoff-<n>`) takes no values: its id is its
 * place in the kickoff's reading, which reading it again moves.
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

/**
 * A roster team's id as the brain names it (`team-<id>`): the onboarding's
 * team record for it takes that id, so one id is one team.
 */
const rosterTeamIdSchema = z
  .string()
  .regex(/^team-[A-Za-z0-9_-]{1,60}$/u, "That isn't a roster team's id.");

const teamRecordSchema = z.strictObject({
  type: z.literal("team"),
  // `team-` is the onboarding's (`team-<id>` for a roster team, now or
  // later): only its own team record takes one (`brainRecordInputSchema`).
  id: z.union([ownIdSchema, rosterTeamIdSchema]),
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
  id: ownIdSchema,
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
  id: ownIdSchema,
  teamId: brainTeamIdSchema,
  sourceId: brainRecordIdSchema,
  date: day,
  role: label,
});

const gapRecordSchema = z.strictObject({
  type: z.literal("gap"),
  id: ownIdSchema,
  question: z.string().trim().min(1).max(brainGapTextMaxLength),
  /** The role that can answer it. */
  owner: label,
  /** Where it was noticed. */
  sourceId: brainRecordIdSchema,
  /**
   * The brain's notes it is about: statements, tools, candidates and team
   * records (`brainGapSubjects`), never a value such as a team's count.
   */
  about: ids,
});

const shortText = z.string().trim().max(300);
const stepText = z.string().trim().min(1).max(300);
const fewWords = z.string().trim().max(80);
const count = z.number().min(0).max(1_000_000);
const outOfTen = z.number().min(0).max(10);

/** A number as people estimated it: nobody measured it yet. */
const estimated = z.literal("estimated");

/** How long one takes, as the people who said it put it: the quickest, a normal and the longest. */
const minutesSchema = z.strictObject({
  quickest: count,
  normal: count,
  longest: count,
  basis: estimated,
});

/**
 * A piece of recurring work a team does, as the onboarding's interviews
 * found it: its drawings are its versions (`workflowVersion`).
 */
const workflowRecordSchema = z.strictObject({
  type: z.literal("workflow"),
  id: ownIdSchema,
  /** Its name in English, by its outcome. */
  name: label,
  /** Its name in the language its people speak. */
  local: label.optional(),
  /** What one of it is called: "invoice". */
  one: fewWords.optional(),
  teamId: brainTeamIdSchema,
  sourceId: brainRecordIdSchema,
  /** How it runs today: only drawn ones are kept yet. */
  status: z.literal("drawn"),
});

/**
 * One drawing of a workflow, as it runs today: its steps, each with who
 * does it (a role) and where, and the rest of what was said about it.
 * Numbers are estimated, never averaged: a range over everyone who gave
 * one, and how many did. Nothing says who told what. A drawing never
 * changes: drawn again, it is a new version, and the newest counts.
 */
const workflowVersionRecordSchema = z.strictObject({
  type: z.literal("workflowVersion"),
  id: ownIdSchema,
  workflowId: brainRecordIdSchema,
  sourceId: brainRecordIdSchema,
  date: day,
  /** How far it is known, under the organization's rules. */
  state: z.enum(["mapping", "saturating", "complete", "variants", "blocked"]),
  /** How many people it was drawn from, never who. */
  people: z.int().min(0).max(1000),
  /** What starts one. */
  starts: shortText,
  steps: z
    .array(
      z.strictObject({
        text: stepText,
        /** The role that does it. */
        who: fewWords,
        tool: fewWords,
        minutes: minutesSchema.nullable(),
        /** A document the company shared describes it too. */
        documented: z.boolean(),
      })
    )
    .max(30),
  /** Where it sits still, and for what. */
  waits: z.array(shortText).max(10),
  /** Cases off the normal path: when, what is done then, how many in ten, and after which step. */
  differently: z
    .array(
      z.strictObject({
        when: shortText,
        does: shortText,
        outOfTen: outOfTen.nullable(),
        after: z.int().min(0).max(30),
      })
    )
    .max(10),
  decides: shortText,
  own: shortText,
  ai: shortText,
  right: shortText,
  ask: shortText,
  next: shortText,
  term: z.strictObject({ word: fewWords, meaning: shortText }).nullable(),
  /** A step told two ways, and why. */
  differs: z
    .strictObject({
      step: z.int().min(0).max(30),
      other: shortText,
      why: z.enum(["condition", "place", "conflict"]),
      because: shortText,
    })
    .nullable(),
  /** How often, over everyone who said, by whose count it is. */
  volumes: z
    .array(
      z.strictObject({
        of: z.enum(["me", "team", "unknown"]),
        per: z.enum(["week", "month"]),
        low: count,
        high: count,
        people: z.int().min(1).max(1000),
        basis: estimated,
      })
    )
    .max(3),
  /** How long one whole one takes, over everyone who said. */
  takes: z
    .strictObject({
      unit: z.enum(["minutes", "hours"]),
      quickest: count,
      longest: count,
      people: z.int().min(1).max(1000),
      basis: estimated,
    })
    .nullable(),
  /** How many in ten come in wrong, over everyone who said. */
  wrong: z
    .strictObject({
      low: outOfTen,
      high: outOfTen,
      people: z.int().min(1).max(1000),
      basis: estimated,
    })
    .nullable(),
  /** What nobody could say yet. */
  open: z.array(shortText).max(5),
});

/** Longest a goal's "how we notice", in characters. */
export const brainGoalNoticeMaxLength = 1000;

const goalWording = {
  /** The goal, as the board says it. */
  title: label,
  /** How the company will notice it is met: empty while nobody said. */
  howWeNotice: z.string().trim().max(brainGoalNoticeMaxLength),
  sourceId: brainRecordIdSchema,
  date: day,
};

/** A board goal, as it was first set: its first wording. */
const goalRecordSchema = z.strictObject({
  type: z.literal("goal"),
  id: ownIdSchema,
  ...goalWording,
});

/** A later wording of a board goal: the newest counts. */
const goalVersionRecordSchema = z.strictObject({
  type: z.literal("goalVersion"),
  id: ownIdSchema,
  goalId: brainRecordIdSchema,
  ...goalWording,
});

/**
 * One of the company's workflows linked to a board goal it serves
 * (`linked: true`), or taken off it (`false`): the newest for the App's
 * workflow counts.
 */
const goalLinkRecordSchema = z.strictObject({
  type: z.literal("goalLink"),
  id: ownIdSchema,
  goalId: brainRecordIdSchema,
  app: appIdSchema,
  workflow: workflowIdSchema,
  linked: z.boolean(),
  date: day,
});

/**
 * What a gap may be about: the records that are notes of their own, so
 * each opens its page. A team's count or stakeholder is a value of its
 * team, a source is where it was noticed (`sourceId`), and another gap
 * is a question, not a note.
 */
export const brainGapSubjects = [
  "statement",
  "tool",
  "candidate",
  "team",
] as const;

/** One record the brain keeps, on `type`: an admin's or the onboarding's. */
export const brainRecordSchema = z.discriminatedUnion("type", [
  sourceRecordSchema,
  toolRecordSchema,
  candidateRecordSchema,
  statementRecordSchema,
  teamRecordSchema,
  teamCountRecordSchema,
  stakeholderRecordSchema,
  gapRecordSchema,
  workflowRecordSchema,
  workflowVersionRecordSchema,
  goalRecordSchema,
  goalVersionRecordSchema,
  goalLinkRecordSchema,
]);
export type BrainRecordInput = z.input<typeof brainRecordSchema>;
export type BrainRecord = z.infer<typeof brainRecordSchema>;
export type BrainRecordType = BrainRecord["type"];
export type WorkflowVersionRecord = Extract<
  BrainRecord,
  { type: "workflowVersion" }
>;

/** The types only the onboarding adds: it draws the work. */
const onboardingTypes: ReadonlySet<BrainRecordType> = new Set([
  "workflow",
  "workflowVersion",
]);

/**
 * One record `brain.addRecords` takes: never one of the onboarding's, by
 * its type or its id.
 */
export const brainRecordInputSchema = brainRecordSchema.superRefine(
  (record, context) => {
    if (onboardingTypes.has(record.type)) {
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "Only the onboarding adds those.",
      });
    }
    if (record.id.startsWith(onboardingIdPrefix)) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: `Ids starting with ${onboardingIdPrefix} are the onboarding's.`,
      });
    }
    if (record.type === "team" && record.id.startsWith("team-")) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Ids starting with team- are the onboarding's.",
      });
    }
  }
);

/** What one `brain.addRecords` call takes. */
export const brainRecordsSchema = z
  .array(brainRecordInputSchema)
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
  "brain.gap_no_owner":
    "Nobody who can sign in holds that question's role on the staff list, so there is no one to ask yet.",
});
