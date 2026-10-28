import type {
  BrainSourceRef,
  ChangeOptions,
  CommandOptions,
  EntitiesListInput,
  EntitySourcesInput,
  EntitySummary,
  RelationsAnswer,
  RelationsExplainInput,
  RelationsExplanation,
  RelationsGetInput,
  MemoriesProposeChangeInput,
  MemoriesPublishInput,
  MemoriesRetireInput,
  CommandReceipt,
  MemoriesGetInput,
  MemoriesLineageInput,
  MemoriesListInput,
  MemoryPack,
  MemoryLineage,
  MemoryPage,
  MemoryRecord,
  ReceiptsGetInput,
  RecallInput,
  RememberInput,
  LessonLineage,
  LessonSummary,
} from "@grasp-os/brain/contract";
import {
  backlinks,
  getDocument,
  history,
  listDocuments,
} from "@grasp-os/brain/documents";
import type { Writer } from "@grasp-os/brain/documents";
import { entitiesFor, entitySources } from "@grasp-os/brain/entities";
import {
  lessonLineage,
  lessonsFor,
  lessonsRetire,
} from "@grasp-os/brain/lesson-reads";
import {
  memoriesGet,
  memoriesList,
  memoriesProposeChange,
  memoriesPublish,
  memoriesRetire,
  receiptsGet,
  remember,
} from "@grasp-os/brain/memories";
import { memoriesLineage } from "@grasp-os/brain/memory-lineage";
import { preparePurge, purge } from "@grasp-os/brain/purge";
import type { OnErase } from "@grasp-os/brain/purge";
import { purgeStatus } from "@grasp-os/brain/purge-ledger";
import { recall } from "@grasp-os/brain/recall";
import { relationsExplain, relationsFor } from "@grasp-os/brain/relations";
import { search } from "@grasp-os/brain/search";
import { follow, read } from "@grasp-os/brain/tools";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type {
  BacklinkPage,
  Collection,
  CollectionInput,
  CopySkillInput,
  DocumentPage,
  DocumentRead,
  DocumentSummary,
  FollowResult,
  HistoryOptions,
  HistoryPage,
  KnowledgeApi,
  KnowledgeCatalog,
  KnowledgeRead,
  ListDocumentsOptions,
  PurgeInput,
  PurgePlan,
  PurgeResult,
  PurgeStatus,
  ReadOptions,
  RestoreInput,
  SaveInput,
  SearchOptions,
  SearchResults,
  SkillCollections,
} from "@grasp-os/shared/knowledge";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { z } from "zod";

import { gapAnswerErasure } from "../brain-gaps.ts";
import { brainRecordErasure } from "../brain-records.ts";
import { documentReadingErasure } from "../onboarding/documents.ts";
import {
  drawingErasure,
  interviewErasure,
} from "../onboarding/interview-erasure.ts";
import { kickoffErasure } from "../onboarding/kickoff-erasure.ts";
import { staffTextErasure } from "../onboarding/staff-text-erasure.ts";
import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import type { Reader } from "./access.ts";
import { appsErasure } from "./apps-collection.ts";
import { catalog } from "./catalog.ts";
import { createCollection, listCollections } from "./collection-rules.ts";
import { copySkill, skillCollections } from "./grasp-skills.ts";
import { personalCollectionId } from "./memory-files.ts";
import { personWriter, restoreVersion, saveDocument } from "./person-writes.ts";
import { brainOf } from "./ports.ts";
import { uploadErasure } from "./uploads.ts";

/** The copies of people's words in core's own tables, as `OnErase` reaches them. */
type Copies = Pick<OnErase, "count" | "rewrite" | "forgetActor">;

/** `copies` as one: each counted, rewritten and forgotten in turn. */
const allOf = (copies: readonly Copies[]): Copies => ({
  count: async (holds) => {
    let total = 0;
    for (const each of copies) {
      // oxlint-disable-next-line no-await-in-loop -- one table after another
      total += await each.count(holds);
    }
    return total;
  },
  rewrite: async (by, rewrite, between) => {
    for (const [index, each] of copies.entries()) {
      if (index > 0) {
        // oxlint-disable-next-line no-await-in-loop -- the purge's hold renewed between tables
        await between?.();
      }
      // oxlint-disable-next-line no-await-in-loop -- one table after another
      await each.rewrite(by, rewrite);
    }
  },
  forgetActor: async (by, userId) => {
    for (const each of copies) {
      // oxlint-disable-next-line no-await-in-loop -- one table after another
      await each.forgetActor(by, userId);
    }
  },
});

/**
 * What a purge reaches of core's own copies (purge.ts `OnErase`): the
 * brain's gap answers and records, the kickoff, the interviews and staff's
 * own text, the originals of uploaded files, the
 * onboarding's readings of the documents shared in it with what was drawn
 * from them, the Apps collection's entries and each person's Personal
 * collection.
 */
const coreErasure = (env: Env): OnErase => {
  const readings = documentReadingErasure(env);
  return {
    ...allOf([
      // The kickoff first: once it is gone, nothing gives the brain its
      // words again while the records are rewritten.
      kickoffErasure(env),
      // The interviews' words, and what was drawn from them, before the
      // brain's records: an intake after reads them as the purge left
      // them, and one before gave the brain words its records step then
      // rewrites. Each intake runs under the onboarding's brain lock, as
      // each of these does.
      interviewErasure(env),
      drawingErasure(env),
      // Staff's own notes and Stephen's setup: a purge of terms only, never
      // one naming a document (it has no `forgetDocuments`).
      staffTextErasure(env),
      gapAnswerErasure(env),
      brainRecordErasure(env),
      // A reading names no person: there is no one to forget in it.
      {
        ...readings,
        forgetActor: async () => {
          // Nothing to forget.
        },
      },
    ]),
    ...uploadErasure(env),
    ...appsErasure(env),
    personalCollection: personalCollectionId,
    forgetDocuments: readings.forgetDocuments,
  };
};

/** A purge's ID, as a purge answers it. */
const purgeIdSchema = z.uuid();

/**
 * Refuses a purge to anyone but an admin (not Grasp staff, who reach a
 * purge only through the admin they help): Knowledge's purge takes no
 * roles, so core checks before it, as the person who purges.
 */
const purgerOf = (person: Identity): Writer => {
  if (person.staff || !isAdmin(person.role)) {
    throw roleErrors.create("role.forbidden");
  }
  return personWriter(person);
};

/**
 * Knowledge for a signed-in person over `/rpc`. Like the session API, it
 * holds no identity: every method checks the session first and acts as
 * the person that check returns. Each takes what the client sent as it is;
 * the Knowledge functions validate it and check access on every call.
 */
export class KnowledgeRpc extends CoreRpcTarget implements KnowledgeApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async #asReader<T>(run: (reader: Reader) => Promise<T>): Promise<T> {
    return await withPerson(
      this.#check,
      async (person) => await run({ type: "person", person })
    );
  }

  async remember(
    input: RememberInput,
    options: CommandOptions
  ): Promise<CommandReceipt> {
    return await this.#asReader(
      async (reader) =>
        await remember(brainOf(this.#env), reader, input, options)
    );
  }

  /** Publishes a record into a team's, the company's or a chat's memory (GRA-298). */
  async memoriesPublish(
    input: MemoriesPublishInput,
    options: CommandOptions
  ): Promise<CommandReceipt> {
    return await this.#asReader(
      async (reader) =>
        await memoriesPublish(brainOf(this.#env), reader, input, options)
    );
  }

  /** Corrects one of the person's own records, keeping its history (GRA-298). */
  async memoriesProposeChange(
    input: MemoriesProposeChangeInput,
    options: ChangeOptions
  ): Promise<CommandReceipt> {
    return await this.#asReader(
      async (reader) =>
        await memoriesProposeChange(brainOf(this.#env), reader, input, options)
    );
  }

  /** Retires a shared record its publisher or an admin no longer wants used (GRA-298). */
  async memoriesRetire(
    input: MemoriesRetireInput,
    options: ChangeOptions
  ): Promise<CommandReceipt> {
    return await this.#asReader(
      async (reader) =>
        await memoriesRetire(brainOf(this.#env), reader, input, options)
    );
  }

  async receiptsGet(input: ReceiptsGetInput): Promise<CommandReceipt> {
    return await this.#asReader(
      async (reader) => await receiptsGet(brainOf(this.#env), reader, input)
    );
  }

  async memoriesGet(input: MemoriesGetInput): Promise<MemoryRecord> {
    return await this.#asReader(
      async (reader) => await memoriesGet(brainOf(this.#env), reader, input)
    );
  }

  async memoriesList(input?: MemoriesListInput): Promise<MemoryPage> {
    return await this.#asReader(
      async (reader) => await memoriesList(brainOf(this.#env), reader, input)
    );
  }

  async lessonsList(): Promise<LessonSummary[]> {
    return await this.#asReader(
      async (reader) => await lessonsFor(brainOf(this.#env), reader)
    );
  }

  async lessonsLineage(input: { lessonId: string }): Promise<LessonLineage> {
    return await this.#asReader(
      async (reader) => await lessonLineage(brainOf(this.#env), reader, input)
    );
  }

  async lessonsRetire(input: {
    lessonId: string;
    expectedRevision: number;
  }): Promise<void> {
    await this.#asReader(async (reader) => {
      await lessonsRetire(brainOf(this.#env), reader, input);
    });
  }

  async memoriesLineage(input: MemoriesLineageInput): Promise<MemoryLineage> {
    return await this.#asReader(
      async (reader) => await memoriesLineage(brainOf(this.#env), reader, input)
    );
  }

  async listCollections(): Promise<Collection[]> {
    return await this.#asReader(
      async (reader) => await listCollections(this.#env, reader)
    );
  }

  async createCollection(input: CollectionInput): Promise<Collection> {
    return await withPerson(
      this.#check,
      async (person) => await createCollection(this.#env, person, input)
    );
  }

  async listDocuments(
    collectionId: string,
    options?: ListDocumentsOptions
  ): Promise<DocumentPage> {
    return await this.#asReader(
      async (reader) =>
        await listDocuments(brainOf(this.#env), reader, collectionId, options)
    );
  }

  async getDocument(
    documentId: string,
    version?: number
  ): Promise<DocumentRead> {
    return await this.#asReader(
      async (reader) =>
        await getDocument(brainOf(this.#env), reader, documentId, version)
    );
  }

  async saveDocument(input: SaveInput): Promise<DocumentSummary> {
    return await withPerson(
      this.#check,
      async (person) => await saveDocument(this.#env, person, input)
    );
  }

  async history(
    documentId: string,
    options?: HistoryOptions
  ): Promise<HistoryPage> {
    return await this.#asReader(
      async (reader) =>
        await history(brainOf(this.#env), reader, documentId, options)
    );
  }

  async restoreVersion(input: RestoreInput): Promise<DocumentSummary> {
    return await withPerson(
      this.#check,
      async (person) => await restoreVersion(this.#env, person, input)
    );
  }

  async backlinks(
    documentId: string,
    options?: ListDocumentsOptions
  ): Promise<BacklinkPage> {
    return await this.#asReader(
      async (reader) =>
        await backlinks(brainOf(this.#env), reader, documentId, options)
    );
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResults> {
    return await this.#asReader(
      async (reader) => await search(brainOf(this.#env), reader, query, options)
    );
  }

  async recall(input: RecallInput): Promise<MemoryPack> {
    return await this.#asReader(
      async (reader) => await recall(brainOf(this.#env), reader, input)
    );
  }

  async entities(input?: EntitiesListInput): Promise<EntitySummary[]> {
    return await this.#asReader(
      async (reader) => await entitiesFor(brainOf(this.#env), reader, input)
    );
  }

  async entitySources(input: EntitySourcesInput): Promise<BrainSourceRef[]> {
    return await this.#asReader(
      async (reader) => await entitySources(brainOf(this.#env), reader, input)
    );
  }

  async relations(input: RelationsGetInput): Promise<RelationsAnswer> {
    return await this.#asReader(
      async (reader) => await relationsFor(brainOf(this.#env), reader, input)
    );
  }

  async relationsExplain(
    input: RelationsExplainInput
  ): Promise<RelationsExplanation> {
    return await this.#asReader(
      async (reader) =>
        await relationsExplain(brainOf(this.#env), reader, input)
    );
  }

  async catalog(): Promise<KnowledgeCatalog> {
    return await this.#asReader(
      async (reader) => await catalog(brainOf(this.#env), reader)
    );
  }

  async read(
    documentId: string,
    options?: ReadOptions
  ): Promise<KnowledgeRead> {
    return await this.#asReader(
      async (reader) =>
        await read(brainOf(this.#env), reader, documentId, options)
    );
  }

  async follow(documentId: string): Promise<FollowResult> {
    return await this.#asReader(
      async (reader) => await follow(brainOf(this.#env), reader, documentId)
    );
  }

  async skillCollections(): Promise<SkillCollections> {
    return await withPerson(
      this.#check,
      async (person) => await skillCollections(this.#env, person)
    );
  }

  async copySkill(input: CopySkillInput): Promise<DocumentSummary> {
    return await withPerson(
      this.#check,
      async (person) => await copySkill(this.#env, person, input)
    );
  }

  async preparePurge(input: PurgeInput): Promise<PurgePlan> {
    return await withPerson(
      this.#check,
      async (person) =>
        await preparePurge(
          brainOf(this.#env),
          purgerOf(person),
          input,
          coreErasure(this.#env)
        )
    );
  }

  async purgeStatus(purgeId: string): Promise<PurgeStatus> {
    return await withPerson(this.#check, async (person) => {
      purgerOf(person);
      return await purgeStatus(
        brainOf(this.#env),
        knowledgeErrors.parse("knowledge.invalid", purgeIdSchema, purgeId)
      );
    });
  }

  async purge(
    input: PurgeInput,
    token: string,
    options?: { fresh?: boolean }
  ): Promise<PurgeResult> {
    return await withPerson(
      this.#check,
      async (person) =>
        await purge(
          brainOf(this.#env),
          purgerOf(person),
          input,
          token,
          coreErasure(this.#env),
          // Only a boolean: a client's value is checked here, as Cap'n
          // Web checks no types.
          { fresh: options?.fresh === true }
        )
    );
  }
}
