import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import {
  brainReceiptIdSchema,
  collectionIdSchema,
  documentIdSchema,
  identifierSchema,
  memoryIdSchema,
} from "./ids.ts";
import { searchQueryMaxLength } from "./knowledge.ts";

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
// is named, never callable here: `BrainRuntimeApi.recordOutcome`, which
// records verified execution outcomes and has no SDK or tool form, so a
// model can't manufacture one by writing "success".

/** This contract's version: what a pack and a receipt say they follow. */
export const brainContractVersion = 1;

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
  id: identifierSchema,
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
  itemIds: z.array(identifierSchema).min(2),
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
  id: identifierSchema,
  contractVersion: z.literal(brainContractVersion),
  /** The retrieval policy that chose the evidence, such as `fulltext@1`. */
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
  operation: z.enum(["remember", "memories.proposeChange"]),
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

/** A correction of a memory record, against the revision it was read at. */
export const memoriesProposeChangeInputSchema = z.strictObject({
  memoryId: memoryIdSchema,
  statement: z.string().trim().min(1).max(rememberTextMaxLength),
  sourceRefs: z.array(brainSourceRefSchema).max(brainSourceRefsMax).optional(),
});
export type MemoriesProposeChangeInput = z.input<
  typeof memoriesProposeChangeInputSchema
>;

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
  "memories.proposeChange",
]);
export type BrainOperation = z.infer<typeof brainOperationSchema>;

export const brainOperations = {
  recall: "action",
  remember: "mutation",
  "receipts.get": "query",
  "memories.get": "query",
  "memories.list": "query",
  "memories.proposeChange": "mutation",
} as const satisfies Record<BrainOperation, "query" | "mutation" | "action">;

/**
 * Why a Brain call was refused: stable codes, never SQL, hidden IDs or
 * source text. Where existence is restricted, `brain.not_found` is the
 * answer whether the thing is missing or the caller can't see it.
 */
export const brainErrors = defineErrorFamily({
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
  "brain.unavailable":
    "The Brain can't answer just now. Try again in a moment.",
});
export type BrainErrorCode = Parameters<typeof brainErrors.create>[0];
