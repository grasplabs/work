import type {
  BrainSourceRef,
  ChangeOptions,
  CommandOptions,
  CommandReceipt,
  EntitiesListInput,
  EntitySourcesInput,
  EntitySummary,
  MemoriesGetInput,
  MemoriesLineageInput,
  MemoriesListInput,
  MemoriesProposeChangeInput,
  MemoriesPublishInput,
  MemoriesRetireInput,
  MemoryPack,
  MemoryLineage,
  MemoryPage,
  MemoryRecord,
  ReceiptsGetInput,
  RelationsAnswer,
  RelationsExplainInput,
  RelationsExplanation,
  RelationsGetInput,
  RecallInput,
  RememberInput,
  LessonLineage,
  LessonSummary,
} from "@grasp-os/brain/contract";
import {
  recallBudgetSchema,
  recallCollectionsMax,
  recallInputSchema,
} from "@grasp-os/brain/contract";
import type {
  BacklinkPage,
  CollectionSearchOptions,
  DocumentPage,
  DocumentRead,
  DocumentSummary,
  FollowResult,
  HistoryOptions,
  HistoryPage,
  KnowledgeRead,
  ListDocumentsOptions,
  PurgeInput,
  PurgePlan,
  PurgeResult,
  ReadOptions,
  RestoreInput,
  SaveInput,
  SearchOptions,
  SearchResults,
} from "@grasp-os/brain/knowledge";
import { z } from "zod";

import {
  collectionIdSchema,
  documentIdSchema,
  identifierSchema,
} from "./ids.ts";
import type { CollectionId, DocumentId } from "./ids.ts";

// Knowledge: Markdown documents with typed frontmatter, in collections. A
// save never overwrites: it adds a version, and names the version it was
// edited from, so two people editing at once get a conflict instead of
// losing a change. Only a purge rewrites versions: an admin erasing
// personal data from all of them.

/**
 * Who may read a collection: everyone in the organization, the members of
 * its teams, or only its owner.
 */
/**
 * Who may read a collection: everyone, its teams, its owner alone, or the
 * admins (Grasp staff included), which only the platform gives one: the
 * onboarding's documents.
 */
export const collectionAccessSchema = z.enum([
  "everyone",
  "teams",
  "me",
  "admins",
]);
export type CollectionAccess = z.infer<typeof collectionAccessSchema>;

/**
 * Where a collection's documents come from: written here, uploaded,
 * shipped by Grasp, or derived from Apps. The last two are
 * read-only for people and agents: only the platform writes them. The
 * Apps collection holds each App's AGENTS.md, and each of its documents
 * is found only by those who may open that App: a listing, read or search
 * never shows the others.
 */
export const collectionSourceSchema = z.enum([
  "here",
  "upload",
  "grasp",
  "apps",
]);
export type CollectionSource = z.infer<typeof collectionSourceSchema>;

/** Sources only the platform writes. */
export const readOnlySources: ReadonlySet<CollectionSource> = new Set([
  "grasp",
  "apps",
]);

/** Most teams one collection is shared with. */
export const collectionMaxTeams = 50;

/** A new collection, as a person creates it. */
export const collectionInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    /** When to use it: what agents see before they look inside. */
    description: z.string().trim().max(1024).default(""),
    access: collectionAccessSchema,
    /** The teams that may read it; only for `teams` access. */
    teams: z
      .array(identifierSchema)
      .max(collectionMaxTeams)
      .default([])
      .transform((teams) => [...new Set(teams)]),
    /** Marks a team collection's content as sensitive for the model gateway. */
    sensitive: z.boolean().default(false),
  })
  .superRefine(({ access, teams, sensitive }, context) => {
    if (access === "teams" && teams.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["teams"],
        message: "A team collection needs at least one team",
      });
    }
    if (access === "admins") {
      context.addIssue({
        code: "custom",
        path: ["access"],
        message: "Only the platform makes a collection for admins",
      });
    }
    if (access !== "teams" && teams.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["teams"],
        message: "Only a team collection has teams",
      });
    }
    if (sensitive && access !== "teams") {
      context.addIssue({
        code: "custom",
        path: ["sensitive"],
        message: "Only a team collection can be marked sensitive",
      });
    }
  });
export type CollectionInput = z.input<typeof collectionInputSchema>;

/**
 * A collection a built-in blueprint asks for (its `blueprint.json`), by an
 * ID of its own, the same in every deployment, which no collection a
 * person creates has (theirs are UUIDs): the install creates it, open to
 * everyone and changed by admins, if it isn't there yet, and every App
 * created from a blueprint that names it shares it, such as the Playbook.
 */
export const declaredCollectionSchema = z.strictObject({
  id: collectionIdSchema.refine(
    (id) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id) && id.length <= 64,
    "Lowercase letters, digits and single hyphens, starting with a letter"
  ),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1024).default(""),
});
export type DeclaredCollection = z.infer<typeof declaredCollectionSchema>;

/** A collection, as the API returns it. */
export interface Collection {
  id: CollectionId;
  name: string;
  description: string;
  /** The user ID of the person who owns it. */
  owner: string;
  access: CollectionAccess;
  /** Team IDs, for `teams` access. */
  teams: string[];
  sensitive: boolean;
  source: CollectionSource;
  /** ISO 8601. */
  createdAt: string;
  /**
   * Whether the person who asked may change it: save and restore its
   * documents. Always `false` for an App or agent reading it.
   */
  writable: boolean;
}

/**
 * A Grasp skill to copy into the client's skills, to adapt there: its
 * `SKILL.md`, at the same path.
 */
export const copySkillInputSchema = z.strictObject({
  documentId: documentIdSchema,
});
export type CopySkillInput = z.input<typeof copySkillInputSchema>;

/**
 * Where skills are: the Grasp skills, which ship with each release and
 * only Grasp changes, and the client's own, which its admins write. `null`
 * while one doesn't exist yet.
 */
export interface SkillCollections {
  grasp: CollectionId | null;
  client: CollectionId | null;
}

/** A collection, as the catalog lists it. */
export interface CatalogCollection {
  id: CollectionId;
  name: string;
  /** When to use it, cut to fit the catalog. */
  description: string;
  sensitive: boolean;
}

/** A skill, as the catalog lists it: read it with `read(documentId)`. */
export interface CatalogSkill {
  documentId: DocumentId;
  collectionId: CollectionId;
  name: string;
  /** When to use it, cut to fit the catalog. */
  description: string;
}

/**
 * A recall as an App asks it of a knowledge resource: collections by the
 * names its declaration gives them, never by ID, since the App doesn't
 * know which collections an admin bound them to. Core maps the names to
 * the bound collections; the Brain's own contract takes only IDs.
 */
export const resourceRecallInputSchema = z.strictObject({
  query: recallInputSchema.shape.query,
  /** Only these of the declared collections; each once. */
  collections: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(recallCollectionsMax)
    .refine((names) => new Set(names).size === names.length, {
      message: "Name each collection once.",
    })
    .optional(),
  budget: recallBudgetSchema.optional(),
});
export type ResourceRecallInput = z.input<typeof resourceRecallInputSchema>;

/**
 * What an agent always has in context: the collections it may read and the
 * skills in them, within a fixed size. `truncated` when some didn't fit;
 * `search` still finds those.
 */
export interface KnowledgeCatalog {
  collections: CatalogCollection[];
  skills: CatalogSkill[];
  truncated: boolean;
}

/**
 * Knowledge as an agent uses it, across every collection it may read: a
 * small catalog always in context, then search, read and follow on demand.
 * Each of those three is recorded in the audit log, and returns where what
 * it read came from; the catalog, which only names what may be read, isn't.
 */
export interface KnowledgeTools {
  /** The readable collections and their skills, sized for always-on context. */
  catalog: () => Promise<KnowledgeCatalog>;
  /** Sections that match `query`, best first, with snippets. */
  search: (query: string, options?: SearchOptions) => Promise<SearchResults>;
  /** A document, or one section of it (a search hit's `section`). */
  read: (documentId: string, options?: ReadOptions) => Promise<KnowledgeRead>;
  /** A document's links and backlinks, and for a skill, its files. */
  follow: (documentId: string) => Promise<FollowResult>;
}

/**
 * What a signed-in person reaches in Knowledge. Every call checks the
 * session and what the person may see and change, on the server, and
 * every read of documents is recorded in the audit log.
 */
export interface KnowledgeApi {
  /** The collections the person may read. */
  listCollections: () => Promise<Collection[]>;
  /**
   * Creates a collection the person owns. Anyone can create one only they
   * can read; shared ones (everyone, teams) only admins.
   */
  createCollection: (input: CollectionInput) => Promise<Collection>;
  listDocuments: (
    collectionId: string,
    options?: ListDocumentsOptions
  ) => Promise<DocumentPage>;
  /** The current version, or `version`. */
  getDocument: (documentId: string, version?: number) => Promise<DocumentRead>;
  /** Saves a new version; `knowledge.conflict` if `ifVersion` is stale. */
  saveDocument: (input: SaveInput) => Promise<DocumentSummary>;
  history: (
    documentId: string,
    options?: HistoryOptions
  ) => Promise<HistoryPage>;
  /** Saves an earlier version's text as a new version. */
  restoreVersion: (input: RestoreInput) => Promise<DocumentSummary>;
  /** A page of the documents that link to this one, in path order. */
  backlinks: (
    documentId: string,
    options?: ListDocumentsOptions
  ) => Promise<BacklinkPage>;
  /**
   * Sections that match `query`, best first, from the collections the
   * person may read, or from one of them.
   */
  search: (query: string, options?: SearchOptions) => Promise<SearchResults>;
  /**
   * The Brain's recall (brain-api.ts): evidence for a question from the
   * collections the person may read, as a bounded memory pack.
   */
  recall: (input: RecallInput) => Promise<MemoryPack>;
  /**
   * The entities the person's readable sources mention, most mentioned
   * first, or those with a name starting with `query` (GRA-305).
   */
  entities: (input?: EntitiesListInput) => Promise<EntitySummary[]>;
  /** The readable sources that mention one entity, at their versions. */
  entitySources: (input: EntitySourcesInput) => Promise<BrainSourceRef[]>;
  /**
   * The relations the person's readable sources state about one entity,
   * on a date and as known at a moment if asked, each with its passage
   * (GRA-306): what a source says, never an accepted fact.
   */
  relations: (input: RelationsGetInput) => Promise<RelationsAnswer>;
  /**
   * The paths out from one entity, one or two relations long, through what
   * the person may read, within a budget of paths and time (GRA-306).
   */
  relationsExplain: (
    input: RelationsExplainInput
  ) => Promise<RelationsExplanation>;
  /**
   * Asks the Brain to remember something of the person's own (brain-api.ts):
   * retry with the same key after a lost reply. Admitted, it is kept as a
   * proposed record; refused by admission, only its receipt is kept.
   */
  remember: (
    input: RememberInput,
    options: CommandOptions
  ) => Promise<CommandReceipt>;
  /** A remember's receipt, recovered after a lost reply. */
  receiptsGet: (input: ReceiptsGetInput) => Promise<CommandReceipt>;
  /** One of the person's own Brain memory records. */
  memoriesGet: (input: MemoriesGetInput) => Promise<MemoryRecord>;
  /**
   * The person's own Brain memory records, or (`among: "shared"`) the
   * shared records of others their memory reads, newest first, a page at
   * a time.
   */
  memoriesList: (input?: MemoriesListInput) => Promise<MemoryPage>;
  /**
   * A record the person may see, what it rests on as far as they may
   * follow it now, and the correction that superseded it (GRA-298).
   */
  memoriesLineage: (input: MemoriesLineageInput) => Promise<MemoryLineage>;
  /**
   * The lessons consolidation kept that the person may see (GRA-301): their
   * own, and a shared chat's they were part of for every turn it rests on.
   */
  lessonsList: () => Promise<LessonSummary[]>;
  /** A lesson they may see, with its versions, as far as they were part of them. */
  lessonsLineage: (input: { lessonId: string }) => Promise<LessonLineage>;
  /** Retires a lesson they may correct, at its revision: never recreated. */
  lessonsRetire: (input: {
    lessonId: string;
    expectedRevision: number;
  }) => Promise<void>;
  /**
   * Publishes a record into a team's, the company's or a chat's memory,
   * where the person may (GRA-298): retry-safe, as `remember`.
   */
  memoriesPublish: (
    input: MemoriesPublishInput,
    options: CommandOptions
  ) => Promise<CommandReceipt>;
  /**
   * Corrects one of the person's own records against the revision read,
   * keeping its history (GRA-298).
   */
  memoriesProposeChange: (
    input: MemoriesProposeChangeInput,
    options: ChangeOptions
  ) => Promise<CommandReceipt>;
  /** Retires a shared record, by its publisher or an admin (GRA-298). */
  memoriesRetire: (
    input: MemoriesRetireInput,
    options: ChangeOptions
  ) => Promise<CommandReceipt>;
  /** The collections the person may read and their skills, as an agent's. */
  catalog: KnowledgeTools["catalog"];
  /** A document, or one section of it. */
  read: KnowledgeTools["read"];
  /** A document's links and backlinks, and for a skill, its files. */
  follow: KnowledgeTools["follow"];
  /**
   * The Grasp skills and the client's skills collections, creating the
   * client's when an admin asks and it doesn't exist yet.
   */
  skillCollections: () => Promise<SkillCollections>;
  /**
   * Copies a Grasp skill into the client's skills, as a new document at
   * the same path: admins only. `knowledge.conflict` when the client's
   * skills have that path already.
   */
  copySkill: (input: CopySkillInput) => Promise<DocumentSummary>;
  /**
   * What a purge would remove, and a token to confirm it with. Admins
   * only, whatever the collection, but for the Grasp skills, the
   * release's text, and an App's entry in the Apps collection while the
   * App holds a term (`knowledge.read_only`, saying where): the entry is
   * made from the App's name, description and current version's
   * AGENTS.md, so the App changes first (a version without it; a name or
   * description only through its builders or Grasp support, as no API
   * changes them yet), then purge. Nothing changes yet.
   */
  preparePurge: (input: PurgeInput) => Promise<PurgePlan>;
  /**
   * Runs the purge `preparePurge` returned `token` for, with the same
   * input, by the same admin, before it expires; else
   * `knowledge.purge_expired`. The audit log records who purged what and
   * why, never what was removed.
   */
  purge: (input: PurgeInput, token: string) => Promise<PurgeResult>;
}

/**
 * One collection, as an App or agent holds it through a permission to read
 * it: `await env.HANDBOOK.getDocument(id)`. It reads that collection only,
 * and only while the person the App or agent acts for may read it too.
 * Reading restricted data puts the chat, App or run it works in in
 * restricted mode, before the data is returned. Every read is recorded in
 * the audit log.
 */
export interface CollectionReader {
  /** A page of the collection's documents, in path order. */
  listDocuments: (options?: ListDocumentsOptions) => Promise<DocumentPage>;
  /** The current version, or `version`. */
  getDocument: (documentId: string, version?: number) => Promise<DocumentRead>;
  history: (
    documentId: string,
    options?: HistoryOptions
  ) => Promise<HistoryPage>;
  /** A page of the documents that link to this one, in path order. */
  backlinks: (
    documentId: string,
    options?: ListDocumentsOptions
  ) => Promise<BacklinkPage>;
  /** Sections of the collection that match `query`, best first. */
  search: (
    query: string,
    options?: CollectionSearchOptions
  ) => Promise<SearchResults>;
  /** A document, or one section of it. */
  read: KnowledgeTools["read"];
  /** A document's links and backlinks, and for a skill, its files. */
  follow: KnowledgeTools["follow"];
  /**
   * The Brain's recall (brain-api.ts) over this collection only: a filter
   * naming another is refused as not found.
   */
  recall: (input: RecallInput) => Promise<MemoryPack>;
}

// The Brain's documents, versions, search and purge, as the Brain defines
// them (@grasp-os/brain/knowledge).
export {
  builtinDocumentTypeSchema,
  collectionSearchOptionsSchema,
  documentIndexingStates,
  documentPathMaxLength,
  documentPathProblem,
  documentPathSchema,
  documentTypeOf,
  documentTypeSchema,
  followMaxEntries,
  historyOptionsSchema,
  isBuiltinDocumentType,
  knowledgeErrors,
  linkPath,
  listDocumentsOptionsSchema,
  pageMaxLimit,
  purgeInputSchema,
  purgeMaxDocuments,
  purgeMaxTerms,
  purgeReasonSchema,
  purgeTermMaxLength,
  purgedMarker,
  readOptionsSchema,
  restoreInputSchema,
  saveInputSchema,
  searchCoverageCap,
  searchMaxLimit,
  searchOptionsSchema,
  searchQuerySchema,
  splitFrontmatterBlock,
  versionInputSchema,
  wikiLinkPattern,
} from "@grasp-os/brain/knowledge";
export {
  memoryKindSchema,
  rememberTextMaxLength,
  searchQueryMaxLength,
} from "@grasp-os/brain/contract";
export type { MemoryKind } from "@grasp-os/brain/contract";
export type {
  Backlink,
  BacklinkPage,
  BuiltinDocumentType,
  CollectionSearchOptions,
  DocumentIndexing,
  DocumentLink,
  DocumentPage,
  DocumentRead,
  DocumentSummary,
  DocumentType,
  FollowResult,
  HistoryOptions,
  HistoryPage,
  KnowledgeRead,
  ListDocumentsOptions,
  Provenance,
  PurgeInput,
  PurgePlan,
  PurgeReason,
  PurgeResult,
  ReadOptions,
  RestoreInput,
  SaveInput,
  SearchCoverage,
  SearchHit,
  SearchOptions,
  SearchResults,
  SkillFile,
  Version,
  VersionSummary,
} from "@grasp-os/brain/knowledge";
