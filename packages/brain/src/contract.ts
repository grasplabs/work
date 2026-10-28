import { z } from "zod";

import { errorFamily } from "./errors.ts";
import {
  brainReceiptIdSchema,
  collectionIdSchema,
  documentIdSchema,
  idSchema,
  memoryIdSchema,
} from "./ids.ts";
import { searchQueryMaxLength } from "./limits.ts";

// The Brain's general contract (GRA-294a; the Brain design's "Brain SDK and
// API"): what callers ask of it and what it answers, the same for an App,
// a screen, an agent and a workflow. The SDK (`@grasp-os/sdk/brain`) types
// calls from these schemas, and core validates every call against them
// again: types never authorize.
//
// What a caller sends is a question or content, narrower filters, a budget
// and a command key, never who it is: the actor, the deployment, the
// effective scope, the current grants and where things are stored are
// the host's (`BrainBinding` in core). Every input is a strict object, so
// a forged `actor` or `admin` field is refused, not ignored.
//
// Three versions, each its own number: the contract's (this module's
// shapes), a retrieval policy's (how core chose the evidence, in each
// pack) and the stores' schema (core's migrations, never seen here).
//
// Interview and privacy operations, and the learning and maintenance
// capabilities, are GRA-294's, behind GRA-327. The one host-only entry
// isn't here: `recordOutcome` (outcomes.ts) records settled execution
// outcomes and has no SDK or tool form, so a model can't manufacture one
// by writing "success".

/** This contract's version: what a pack and a receipt say they follow. */
export const brainContractVersion = 1;

export { searchQueryMaxLength } from "./limits.ts";

/** A version number of a document or memory: 1 and up. */
const revisionSchema = z.int().min(1);

/** An ISO 8601 date and time. */
const instantSchema = z.iso.datetime({ offset: true });

/**
 * Where a piece of evidence comes from, exactly: a validated reference to
 * something the Brain holds, at the version it was read at, never a URL a
 * model supplied. Recall returns only `document` references until memory
 * records exist (the design's P01); `memory` is reserved in the union so
 * callers key citations on `kind` from the start.
 */
export const brainSourceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("document"),
    documentId: documentIdSchema,
    collectionId: collectionIdSchema,
    /** The document's version the evidence was read at. */
    version: revisionSchema,
    /** The section's place in the document, from 0; the whole one if absent. */
    section: z.int().min(0).optional(),
  }),
  z.strictObject({
    kind: z.literal("memory"),
    memoryId: memoryIdSchema,
    revision: revisionSchema,
  }),
]);
export type BrainSourceRef = z.infer<typeof brainSourceRefSchema>;

/** Most source references one item or command names. */
export const brainSourceRefsMax = 20;

// --- recall -----------------------------------------------------------------

/** The most a recall may ask for; core clamps every budget to these. */
export const recallLimits = {
  /** Items in one pack. */
  maxItems: 50,
  /** Tokens the pack's statements may take, as core counts them. */
  maxTokens: 16_000,
  /** How long core may spend before it answers with what it has. */
  deadlineMs: 10_000,
} as const;

/** What a recall uses when its caller asks for no budget. */
export const recallDefaults = {
  maxItems: 10,
  maxTokens: 4000,
  deadlineMs: 5000,
} as const;

/**
 * How much a recall may spend. Each bound is the most the caller wants;
 * core may give less (its own limits, the caller's binding), and says so
 * in the pack (`truncated`, `coverage`).
 */
export const recallBudgetSchema = z.strictObject({
  maxItems: z.int().min(1).max(recallLimits.maxItems).optional(),
  maxTokens: z.int().min(1).max(recallLimits.maxTokens).optional(),
  deadlineMs: z.int().min(1).max(recallLimits.deadlineMs).optional(),
});
export type RecallBudget = z.infer<typeof recallBudgetSchema>;

/** Most collections a recall's filter may name. */
export const recallCollectionsMax = 50;

/**
 * Narrows what a recall reads. A filter can only narrow: a collection the
 * caller may not read is refused as the caller can't see it, never read.
 */
export const recallFiltersSchema = z.strictObject({
  /** Only these collections, of those the caller may read; each once. */
  collectionIds: z
    .array(collectionIdSchema)
    .min(1)
    .max(recallCollectionsMax)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Name each collection once.",
    })
    .optional(),
});
export type RecallFilters = z.infer<typeof recallFiltersSchema>;

/** A recall: a question, in the caller's words, and how much to spend. */
export const recallInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(searchQueryMaxLength),
  filters: recallFiltersSchema.optional(),
  budget: recallBudgetSchema.optional(),
});
export type RecallInput = z.input<typeof recallInputSchema>;

/** What a memory item says it is. */
export const memoryKindSchema = z.enum([
  "fact",
  "experience",
  "lesson",
  "preference",
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/**
 * How far an item is to be taken as settled: `source` is what a source
 * says, as written; `accepted` was accepted by its owner; `proposed`
 * awaits that.
 */
export const authorityStateSchema = z.enum(["source", "proposed", "accepted"]);
export type AuthorityState = z.infer<typeof authorityStateSchema>;

/** One piece of evidence in a pack: what it says, and where from. */
export const memoryItemSchema = z.strictObject({
  /** Stable within the pack; a memory's ID once memory records exist. */
  id: idSchema,
  /** The evidence's revision: its document's version, or its memory's. */
  revision: revisionSchema,
  kind: memoryKindSchema,
  /** The evidence's own text: an excerpt, never an analysis of it. */
  statement: z.string(),
  sourceRefs: z.array(brainSourceRefSchema).min(1).max(brainSourceRefsMax),
  authorityState: authorityStateSchema,
  /** When what it says applies, as far as known. */
  validFrom: instantSchema.nullable(),
  validTo: instantSchema.nullable(),
  /** When the Brain recorded it. */
  recordedAt: instantSchema,
  /** Why it applies to the question, as core's routing rules found it. */
  applicability: z.string(),
  /** Where in its source, for a person: its title and headings. */
  citationLocator: z.array(z.string()).max(16),
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

/** Two items of the pack that disagree, unresolved. */
export const memoryConflictSchema = z.strictObject({
  itemIds: z.array(idSchema).min(2),
  /** What they disagree on. */
  about: z.string(),
});
export type MemoryConflict = z.infer<typeof memoryConflictSchema>;

/** Something the question needs that the evidence read doesn't hold. */
export const memoryGapSchema = z.strictObject({ about: z.string() });
export type MemoryGap = z.infer<typeof memoryGapSchema>;

/**
 * How much of what a recall set out to read it read. `complete`: the
 * bounded read the policy specifies finished; never that the Brain holds
 * nothing more on the question (a top-K read is never exhaustive).
 * `bounded`: a budget stopped it. `degraded`: a route failed or was
 * skipped, so missing evidence proves nothing.
 */
export const coverageSchema = z.strictObject({
  state: z.enum(["complete", "bounded", "degraded"]),
  /** The routes read, such as `fulltext`. */
  queriedRoutes: z.array(z.string()),
  /** Routes not read, each with why (`not_enabled`, `deadline`, `failed`). */
  omittedRoutes: z.array(
    z.strictObject({ route: z.string(), reason: z.string() })
  ),
});
export type Coverage = z.infer<typeof coverageSchema>;

/**
 * A recall's answer: the evidence that applies, bounded, with what it
 * conflicts on and lacks, how far the read got, and the versions it
 * came from. Evidence, never generated analysis: a later `reflect`
 * would be its own operation.
 */
export const memoryPackSchema = z.strictObject({
  id: idSchema,
  contractVersion: z.literal(brainContractVersion),
  /** The retrieval policy that chose the evidence, such as `fulltext@2`. */
  retrievalPolicyVersion: z.string().min(1),
  items: z.array(memoryItemSchema).max(recallLimits.maxItems),
  /** Every source version the items cite, once each. */
  sourceVersions: z.array(brainSourceRefSchema),
  conflicts: z.array(memoryConflictSchema),
  gaps: z.array(memoryGapSchema),
  coverage: coverageSchema,
  /** Whether a budget left out evidence that applied. */
  truncated: z.boolean(),
  warnings: z.array(z.string()),
  /** The items' statements, as core counts tokens. */
  tokenCount: z.int().min(0),
  /**
   * The caller's access when the pack was made: a cached pack is used again
   * only at the same revision, and checked again before it enters a prompt.
   */
  accessRevision: z.string().min(1),
  /** The search index's generation the read used. */
  indexGeneration: z.string().min(1),
  createdAt: instantSchema,
});
export type MemoryPack = z.infer<typeof memoryPackSchema>;

// --- remember and receipts --------------------------------------------------

/** Longest content one remember submits, in characters. */
export const rememberTextMaxLength = 8000;

/**
 * Something to remember: an observation, preference, experience or lesson,
 * with the evidence it rests on. The caller never chooses its scope or
 * audience.
 */
export const rememberInputSchema = z.strictObject({
  kind: memoryKindSchema,
  text: z.string().trim().min(1).max(rememberTextMaxLength),
  sourceRefs: z.array(brainSourceRefSchema).max(brainSourceRefsMax).optional(),
});
export type RememberInput = z.input<typeof rememberInputSchema>;

/** Longest idempotency key. */
export const idempotencyKeyMaxLength = 200;

/**
 * How a command is made retry-safe: the same key and request answer the
 * recorded receipt while it is kept; the same key with another request is
 * an idempotency conflict. Keys are scoped by core to the deployment, the
 * caller, its binding and the operation. A change to an existing record
 * names the revision it was made against.
 */
export const commandOptionsSchema = z.strictObject({
  idempotencyKey: z.string().min(8).max(idempotencyKeyMaxLength),
  expectedRevision: revisionSchema.optional(),
});
export type CommandOptions = z.input<typeof commandOptionsSchema>;

/**
 * A change to an existing record: its key, and the revision it was made
 * against, always. A stale one is a `brain.revision_conflict`, never an
 * overwrite of newer work.
 */
export const changeOptionsSchema = z.strictObject({
  idempotencyKey: commandOptionsSchema.shape.idempotencyKey,
  expectedRevision: revisionSchema,
});
export type ChangeOptions = z.input<typeof changeOptionsSchema>;

/**
 * Where a command stands. `committed`: its change and its indexing are
 * stored together; `proposed`: it awaits acceptance; `queued`: it waits
 * for background work; `completed` and `failed`: that work ended.
 */
export const commandStatusSchema = z.enum([
  "committed",
  "proposed",
  "queued",
  "completed",
  "failed",
]);
export type CommandStatus = z.infer<typeof commandStatusSchema>;

/**
 * A command's durable receipt. A committed `remember` proves its input
 * was durably kept: not that it is indexed (see `indexingState`), nor that
 * it is accepted as fact.
 */
export const commandReceiptSchema = z.strictObject({
  id: brainReceiptIdSchema,
  contractVersion: z.literal(brainContractVersion),
  operation: z.enum([
    "remember",
    "memories.proposeChange",
    "memories.publish",
    "memories.retire",
  ]),
  /** The validated request's hash, which a retry must match. */
  requestHash: z.string().min(1),
  status: commandStatusSchema,
  resourceRefs: z.array(brainSourceRefSchema),
  indexingState: z.enum(["pending", "indexed", "failed"]),
  /** Until when the receipt is kept; after it, the key is forgotten. */
  retentionUntil: instantSchema,
  createdAt: instantSchema,
});
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

/** Recovers a command's receipt after a lost response. */
export const receiptsGetInputSchema = z.strictObject({
  receiptId: brainReceiptIdSchema,
});
export type ReceiptsGetInput = z.input<typeof receiptsGetInputSchema>;

// --- memories (types now; handlers come with their first caller) ------------

/** Where a memory record is read: whose, and so who may read it. */
export const memoryScopeSchema = z.enum([
  "person",
  "session",
  "team",
  "company",
]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

/** A memory record as a caller may see it within its binding. */
export const memoryRecordSchema = z.strictObject({
  id: memoryIdSchema,
  revision: revisionSchema,
  kind: memoryKindSchema,
  scope: memoryScopeSchema,
  statement: z.string(),
  sourceRefs: z.array(brainSourceRefSchema).max(brainSourceRefsMax),
  state: z.enum(["proposed", "accepted", "retired"]),
  validFrom: instantSchema.nullable(),
  validTo: instantSchema.nullable(),
  recordedAt: instantSchema,
  reviewAt: instantSchema.nullable(),
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const memoriesGetInputSchema = z.strictObject({
  memoryId: memoryIdSchema,
});
export type MemoriesGetInput = z.input<typeof memoriesGetInputSchema>;

/** Most records one page holds. */
export const memoriesPageMax = 100;

export const memoriesListInputSchema = z.strictObject({
  kind: memoryKindSchema.optional(),
  /**
   * Whose records: the caller's own (the default), or the shared records
   * of others that the caller's memory audience reads now (GRA-298).
   */
  among: z.enum(["mine", "shared"]).optional(),
  limit: z.int().min(1).max(memoriesPageMax).optional(),
  cursor: z.string().max(512).optional(),
});
export type MemoriesListInput = z.input<typeof memoriesListInputSchema>;

/** A page of memory records, and where the next one starts. */
export const memoryPageSchema = z.strictObject({
  records: z.array(memoryRecordSchema).max(memoriesPageMax),
  cursor: z.string().nullable(),
});
export type MemoryPage = z.infer<typeof memoryPageSchema>;

/** A record as an inspection shows it (GRA-298). */
export const shownMemorySchema = memoryRecordSchema.extend({
  /** Who published it, as the host names them; null for the reader's own. */
  by: z.string().nullable(),
});
export type ShownMemory = z.infer<typeof shownMemorySchema>;

export const memoriesLineageInputSchema = z.strictObject({
  memoryId: memoryIdSchema,
});
export type MemoriesLineageInput = z.input<typeof memoriesLineageInputSchema>;

/**
 * One thing a record rests on, as the reader may see it now: a record it
 * cites, at the revision cited, or a document version, with where the
 * document is and its version now. What the reader can't see isn't here
 * at all.
 */
export const lineageNodeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("memory"),
    /** The record that cites it. */
    citedBy: memoryIdSchema,
    citedRevision: revisionSchema,
    record: shownMemorySchema,
  }),
  z.strictObject({
    kind: z.literal("document"),
    citedBy: memoryIdSchema,
    documentId: documentIdSchema,
    collectionId: collectionIdSchema,
    version: revisionSchema,
    section: z.int().min(0).optional(),
    title: z.string(),
    path: z.string(),
    currentVersion: revisionSchema,
  }),
]);
export type LineageNode = z.infer<typeof lineageNodeSchema>;

/**
 * A record's lineage (GRA-298): the record, what it rests on as far as
 * the reader may follow it, and the correction that superseded it.
 */
export const memoryLineageSchema = z.strictObject({
  record: shownMemorySchema,
  restsOn: z.array(lineageNodeSchema),
  supersededBy: shownMemorySchema.nullable(),
});
export type MemoryLineage = z.infer<typeof memoryLineageSchema>;

/** A correction of a memory record, against the revision it was read at. */
export const memoriesProposeChangeInputSchema = z.strictObject({
  memoryId: memoryIdSchema,
  statement: z.string().trim().min(1).max(rememberTextMaxLength),
  sourceRefs: z.array(brainSourceRefSchema).max(brainSourceRefsMax).optional(),
});
export type MemoriesProposeChangeInput = z.input<
  typeof memoriesProposeChangeInputSchema
>;

/** The scopes a record is published into: shared ones, never a person's. */
export const publishScopeSchema = z.enum(["team", "company", "session"]);
export type PublishScope = z.infer<typeof publishScopeSchema>;

/**
 * A record published into a shared scope (GRA-298): its scope, and the
 * key of it (a team's or a chat's ID; none for the company), what it says
 * and what it rests on. The host decides who may publish where.
 */
export const memoriesPublishInputSchema = z
  .strictObject({
    scope: publishScopeSchema,
    scopeId: z.string().min(1).max(128).optional(),
    kind: memoryKindSchema,
    text: z.string().trim().min(1).max(rememberTextMaxLength),
    sourceRefs: z
      .array(brainSourceRefSchema)
      .max(brainSourceRefsMax)
      .optional(),
  })
  .refine(
    ({ scope, scopeId }) => (scope === "company") === (scopeId === undefined)
  );
export type MemoriesPublishInput = z.input<typeof memoriesPublishInputSchema>;

/** A shared record to retire (GRA-298): by its publisher or an admin. */
export const memoriesRetireInputSchema = z.strictObject({
  memoryId: memoryIdSchema,
});
export type MemoriesRetireInput = z.input<typeof memoriesRetireInputSchema>;

// --- skills -----------------------------------------------------------------

/**
 * A word a skill's manifest and a task share (a task type, a trait):
 * lowercase letters, digits and `.`, `_`, `:` or `-`. Matched exactly,
 * never by similarity.
 */
export const skillTokenSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);

/** The longest capability name a manifest may require. */
export const skillCapabilityMax = 512;

/**
 * A capability a skill requires, by the host's own name for it, whatever
 * its case or length (core's: `connection:MAIL_SEND`, or with a 256
 * character object ID in it): only the host names capabilities, and they
 * are matched exactly, so the Brain bounds them and nothing more. No
 * whitespace or control characters, which no host name holds.
 */
export const skillCapabilitySchema = z
  .string()
  .min(1)
  .max(skillCapabilityMax)
  .regex(/^[^\s\p{Cc}]+$/u);

/** Most traits a task names. */
export const skillTraitsMax = 32;

/**
 * What a caller asks a skill for: the task's type and what holds of it
 * (its traits), never who it is or what it may do: the host says that.
 */
export const skillsSelectInputSchema = z.strictObject({
  task: z.strictObject({
    type: skillTokenSchema,
    traits: z
      .array(skillTokenSchema)
      .max(skillTraitsMax)
      .refine((traits) => new Set(traits).size === traits.length, {
        message: "Name each trait once.",
      })
      .optional(),
  }),
});
export type SkillsSelectInput = z.input<typeof skillsSelectInputSchema>;

/** A skill at one exact version: what a selection pins and a read returns. */
export const skillRefSchema = z.strictObject({
  documentId: documentIdSchema,
  collectionId: collectionIdSchema,
  name: z.string().min(1).max(64),
  version: revisionSchema,
});
export type SkillRef = z.infer<typeof skillRefSchema>;

/**
 * Why a skill whose tasks name the task's type wasn't selected, or that
 * it was. Given only for skills the caller may read.
 */
export const skillOutcomeSchema = z.enum([
  "selected",
  "ambiguous",
  "excluded",
  "precondition_unmet",
  "missing_capability",
  "prerequisite_missing",
  "dependency_missing",
  "replaced",
  "retired",
  /** It applied so far, but the selection stopped before it could tell (`incomplete`). */
  "incomplete",
]);
export type SkillOutcome = z.infer<typeof skillOutcomeSchema>;

/** Why no skill was selected. */
export const noSkillReasonSchema = z.enum([
  /** No skill the caller may read applies to the task. */
  "no_match",
  /** More than one applies, and nothing says which: none is forced. */
  "ambiguous",
  /** More skills than one selection reads: none is chosen from a part. */
  "incomplete",
]);
export type NoSkillReason = z.infer<typeof noSkillReasonSchema>;

/**
 * A selection: the one applicable skill, pinned at the version read, with
 * the versions it depends on; or an explicit no-skill result. Either way,
 * every skill considered, with why. A host checks what it hands a caller
 * against it.
 */
export const skillSelectionSchema = z.strictObject({
  id: z.string(),
  contractVersion: z.int(),
  /** The rules it followed: deterministic, never a model's choice. */
  selectionPolicyVersion: z.string(),
  result: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("skill"),
      skill: skillRefSchema,
      dependencies: z.array(skillRefSchema),
    }),
    z.strictObject({ kind: z.literal("none"), reason: noSkillReasonSchema }),
  ]),
  considered: z.array(
    z.strictObject({ skill: skillRefSchema, outcome: skillOutcomeSchema })
  ),
  createdAt: z.string(),
});
export type SkillSelection = z.infer<typeof skillSelectionSchema>;

/** A skill read at the exact version a selection pinned. */
export const skillsReadInputSchema = z.strictObject({
  documentId: documentIdSchema,
  version: revisionSchema,
});
export type SkillsReadInput = z.input<typeof skillsReadInputSchema>;

/** A skill's name, as its frontmatter has it. */
export const skillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/** Another skill: by name in the same collection, or by collection and name. */
export const skillReferenceSchema = z.union([
  skillNameSchema,
  z.strictObject({ collection: collectionIdSchema, name: skillNameSchema }),
]);
export type SkillReference = z.infer<typeof skillReferenceSchema>;

/** Another skill at one exact version: `name@version`, or qualified by collection. */
export const skillDependencySchema = z.union([
  z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*@[1-9][0-9]{0,8}$/u),
  z.strictObject({
    collection: collectionIdSchema,
    name: skillNameSchema,
    version: revisionSchema,
  }),
]);
export type SkillDependency = z.infer<typeof skillDependencySchema>;

/**
 * What a skill's frontmatter says of when to use it (the Brain design's
 * skill manifest), all of it exact words the host defines, matched as
 * they are. A skill without `tasks` applies to no task: none is ever
 * selected because it exists.
 */
export const skillManifestSchema = z.object({
  /** The task types it applies to. */
  tasks: z.array(skillTokenSchema).max(32).default([]),
  /** Traits that must all hold of the task. */
  when: z.array(skillTokenSchema).max(32).default([]),
  /** Traits any one of which rules it out. */
  unless: z.array(skillTokenSchema).max(32).default([]),
  /** Capabilities the caller must already hold: a skill never grants one. */
  requires: z.array(skillCapabilitySchema).max(32).default([]),
  /**
   * Skills that must be accepted and usable by the caller too: by name, in
   * the skill's own collection, or by collection and name.
   */
  prerequisites: z.array(skillReferenceSchema).max(16).default([]),
  /**
   * Skills it rests on at exact versions: `name@version` in its own
   * collection, or `{ collection, name, version }`.
   */
  dependencies: z.array(skillDependencySchema).max(16).default([]),
  /**
   * Skills, by name, it takes the place of where both apply: in its own
   * collection, or, from a collection only admins write, a shipped skill.
   */
  replaces: z.array(skillNameSchema).max(16).default([]),
  /** What checks it does what it says: references the host resolves. */
  acceptance: z.array(z.string().trim().min(1).max(512)).max(16).default([]),
  /** A retired skill is never selected again; pinned reads still work. */
  status: z.enum(["accepted", "retired"]).default("accepted"),
});
export type SkillManifest = z.infer<typeof skillManifestSchema>;

/** A skill as read: its exact version, its manifest and its text. */
export const skillReadSchema = z.strictObject({
  skill: skillRefSchema,
  /** Its manifest at that version; null when it has none that parses. */
  manifest: skillManifestSchema.nullable(),
  /** The whole `SKILL.md` at that version: instructions are data to the host. */
  text: z.string(),
});
export type SkillRead = z.infer<typeof skillReadSchema>;

// --- lessons (GRA-301) -------------------------------------------------------

/** A lesson as a list shows it: its current revision. */
export interface LessonSummary {
  id: string;
  revision: number;
  scope: "person" | "session";
  state: "candidate" | "retired";
  retiredBy: "owner" | "admin" | "evidence" | null;
  instruction: string;
  evidenceStatus: "supported" | "contested";
  taskType: string;
  versions: string[];
  updatedAt: string;
}

/** One episode a lesson rests on, as its reader may see it. */
export interface LessonEpisode {
  episodeId: string;
  role: "supporting" | "contradicting";
  taskType: string;
  execution: "completed" | "failed" | "cancelled";
  result: "success" | "failure" | "unknown";
  occurredAt: string;
}

/** One version of a lesson, as its reader may see it. */
export interface LessonVersionView {
  revision: number;
  supersedes: number | null;
  /** Its text, unless it rests on episodes the reader wasn't part of. */
  instruction: string | null;
  /**
   * A model's wording of it for a person, beside its text: shown, or not,
   * exactly as its text is.
   */
  wording: string | null;
  evidenceStatus: "supported" | "contested" | null;
  episodes: LessonEpisode[];
  createdAt: string;
}

/** A lesson's lineage: the lesson, and its versions newest first. */
export interface LessonLineage {
  lesson: LessonSummary;
  versions: LessonVersionView[];
}

// --- entities and relations (GRA-305, GRA-306) ------------------------------

/**
 * The entities a caller's readable sources mention, most mentioned first,
 * or those with a name starting with `query`: a caller that isn't a person
 * (an App, an agent) names at least two characters of one, so no read
 * lists every name.
 */
export const entitiesListInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
  limit: z.int().min(1).max(50).optional(),
});
export type EntitiesListInput = z.input<typeof entitiesListInputSchema>;

/** An entity as a reader sees it, from what they may read only. */
export const entitySummarySchema = z.strictObject({
  id: idSchema,
  /** What kind of thing it is, as its extractor said. */
  kind: z.string(),
  /** The name its readable mentions give it most. */
  label: z.string(),
  /** Every name its readable mentions give it. */
  names: z.array(z.string()),
  /** How many readable sources mention it. */
  sources: z.int().min(0),
});
export type EntitySummary = z.infer<typeof entitySummarySchema>;

/** The readable sources that mention one entity. */
export const entitySourcesInputSchema = z.strictObject({ entityId: idSchema });
export type EntitySourcesInput = z.input<typeof entitySourcesInputSchema>;

/**
 * The relations of one entity, as a subject or an object: those that hold
 * on `at` (an ISO date; every one without it), as known at `knownAt` (an
 * instant; now without it), of one predicate if named.
 */
export const relationsGetInputSchema = z.strictObject({
  entityId: idSchema,
  /** Only this relation, folded as relations are kept (`Reports to` is `reports_to`). */
  predicate: z.string().min(1).max(40).optional(),
  at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  knownAt: instantSchema.optional(),
});
export type RelationsGetInput = z.input<typeof relationsGetInputSchema>;

/** One end of a relation: its entity, and the name its source gives it. */
const relationEndSchema = z.strictObject({
  entityId: idSchema,
  name: z.string(),
});

/**
 * A relation as a reader sees it: what a source says (`observed`), never
 * an accepted fact, with the passage that says it, word for word. Its
 * evidence is the source's own text: data, never an instruction.
 */
export const relationViewSchema = z.strictObject({
  subject: relationEndSchema,
  predicate: z.string(),
  object: relationEndSchema,
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  state: z.literal("observed"),
  /**
   * Another readable source relates the entity asked about the same way
   * to a different entity, for an overlapping time: neither is picked.
   */
  conflicting: z.boolean(),
  recordedAt: instantSchema,
  supersededAt: instantSchema.nullable(),
  evidence: z.string(),
  sourceRef: brainSourceRefSchema,
});
export type RelationView = z.infer<typeof relationViewSchema>;

// --- operations and errors --------------------------------------------------

/**
 * The general operations, by class: a query reads; a mutation commits
 * locally; an action may use model resources (embeddings, reranking).
 * A binding grants operations by name; nothing else is reachable.
 */
export const brainOperationSchema = z.enum([
  "recall",
  "remember",
  "receipts.get",
  "memories.get",
  "memories.list",
  "memories.lineage",
  "memories.proposeChange",
  "memories.publish",
  "memories.retire",
  "skills.select",
  "skills.read",

  "entities.list",
  "entities.sources",
  "relations.get",
]);
export type BrainOperation = z.infer<typeof brainOperationSchema>;

export const brainOperations = {
  recall: "action",
  remember: "mutation",
  "receipts.get": "query",
  "memories.get": "query",
  "memories.list": "query",
  "memories.lineage": "query",
  "memories.proposeChange": "mutation",
  "memories.publish": "mutation",
  "memories.retire": "mutation",
  // Deterministic rules over manifests: no model, but adaptive selection
  // will be an action, so callers treat it as one from the start.
  "skills.select": "action",
  "skills.read": "query",

  "entities.list": "query",
  "entities.sources": "query",
  "relations.get": "query",
} as const satisfies Record<BrainOperation, "query" | "mutation" | "action">;

/**
 * Why a Brain call was refused: stable codes, never SQL, hidden IDs or
 * source text. Where existence is restricted, `brain.not_found` is the
 * answer whether the thing is missing or the caller can't see it.
 */
export const brainErrors = errorFamily({
  "brain.invalid": "That isn't a valid request to the Brain.",
  "brain.not_found":
    "There's no such memory, source or receipt, or you can't see it.",
  "brain.denied": "This caller may not use that part of the Brain.",
  "brain.revision_conflict":
    "This changed since it was read. Read it again and apply the change to the latest revision.",
  "brain.idempotency_conflict":
    "This command key was already used for a different request.",
  "brain.receipt_expired": "This receipt is no longer kept.",
  "brain.budget_exceeded": "This request is over the Brain's limits for it.",
  "brain.incompatible":
    "This request follows a contract version the Brain doesn't support.",
  "brain.revoked":
    "Evidence this run recalled can no longer be read. Recall again before using it.",
  "brain.unavailable":
    "The Brain can't answer just now. Try again in a moment.",
});
export type BrainErrorCode = Parameters<typeof brainErrors.create>[0];
