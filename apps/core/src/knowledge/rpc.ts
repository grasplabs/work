import type {
  BrainSourceRef,
  EntitiesListInput,
  EntitySourcesInput,
  EntitySummary,
  RelationsAnswer,
  RelationsExplainInput,
  RelationsExplanation,
  RelationsGetInput,
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
  LessonLineage,
  LessonSummary,
} from "@grasp-os/brain/contract";
import {
  backlinks,
  getDocument,
  history,
  listDocuments,
} from "@grasp-os/brain/documents";
import { entitiesFor, entitySources } from "@grasp-os/brain/entities";
import {
  lessonLineage,
  lessonsFor,
  lessonsRetire,
} from "@grasp-os/brain/lesson-reads";
import {
  memoriesGet,
  memoriesList,
  receiptsGet,
} from "@grasp-os/brain/memories";
import { memoriesLineage } from "@grasp-os/brain/memory-lineage";
import { recall } from "@grasp-os/brain/recall";
import { relationsExplain, relationsFor } from "@grasp-os/brain/relations";
import { search } from "@grasp-os/brain/search";
import { follow, read } from "@grasp-os/brain/tools";
import type {
  BacklinkPage,
  Collection,
  DocumentPage,
  DocumentRead,
  FollowResult,
  HistoryOptions,
  HistoryPage,
  KnowledgeApi,
  KnowledgeRead,
  ListDocumentsOptions,
  ReadOptions,
  SearchOptions,
  SearchResults,
} from "@grasp-os/shared/knowledge";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import type { Reader } from "./access.ts";
import { listCollections } from "./collection-rules.ts";
import { brainOf } from "./ports.ts";

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

  async history(
    documentId: string,
    options?: HistoryOptions
  ): Promise<HistoryPage> {
    return await this.#asReader(
      async (reader) =>
        await history(brainOf(this.#env), reader, documentId, options)
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
}
