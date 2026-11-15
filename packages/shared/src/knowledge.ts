import type {
  BrainSourceRef,
  CommandReceipt,
  EntitiesListInput,
  EntitySourcesInput,
  EntitySummary,
  MemoriesGetInput,
  MemoriesLineageInput,
  MemoriesListInput,
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
  LessonLineage,
  LessonSummary,
} from "@grasp-os/brain/contract";
import type {
  BacklinkPage,
  DocumentPage,
  DocumentRead,
  FollowResult,
  HistoryOptions,
  HistoryPage,
  KnowledgeRead,
  ListDocumentsOptions,
  ReadOptions,
  SearchOptions,
  SearchResults,
} from "@grasp-os/brain/knowledge";
import { z } from "zod";

import type { CollectionId } from "./ids.ts";

// Knowledge: Markdown documents with typed frontmatter, in collections. A
// save never overwrites: it adds a version, and names the version it was
// edited from, so two people editing at once get a conflict instead of
// losing a change.

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
}

/**
 * What a signed-in person reaches in Knowledge. Every call checks the
 * session and what the person may see and change, on the server, and
 * every read of documents is recorded in the audit log.
 */
export interface KnowledgeApi {
  /** The collections the person may read. */
  listCollections: () => Promise<Collection[]>;
  listDocuments: (
    collectionId: string,
    options?: ListDocumentsOptions
  ) => Promise<DocumentPage>;
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
  /** A command's receipt, recovered after a lost reply. */
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
  /** A document, or one section of it (a search hit's `section`). */
  read: (documentId: string, options?: ReadOptions) => Promise<KnowledgeRead>;
  /** A document's links and backlinks, and for a skill, its files. */
  follow: (documentId: string) => Promise<FollowResult>;
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
  purgedMarker,
  readOptionsSchema,
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
  ReadOptions,
  SearchCoverage,
  SearchHit,
  SearchOptions,
  SearchResults,
  SkillFile,
  Version,
  VersionSummary,
} from "@grasp-os/brain/knowledge";
