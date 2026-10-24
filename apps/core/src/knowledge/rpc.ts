import type {
  CommandOptions,
  CommandReceipt,
  MemoriesGetInput,
  MemoriesListInput,
  MemoryPack,
  MemoryPage,
  MemoryRecord,
  ReceiptsGetInput,
  RecallInput,
  RememberInput,
} from "@grasp-os/shared/brain-api";
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
  ReadOptions,
  RestoreInput,
  SaveInput,
  SearchOptions,
  SearchResults,
  SkillCollections,
} from "@grasp-os/shared/knowledge";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { gapAnswerErasure } from "../brain-gaps.ts";
import { brainRecordErasure } from "../brain-records.ts";
import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import type { Reader } from "./access.ts";
import { appsErasure } from "./apps-collection.ts";
import { createCollection, listCollections } from "./collections.ts";
import {
  backlinks,
  getDocument,
  history,
  listDocuments,
  personWriter,
  restoreVersion,
  saveDocument,
} from "./documents.ts";
import type { Writer } from "./documents.ts";
import { copySkill, skillCollections } from "./grasp-skills.ts";
import {
  memoriesGet,
  memoriesList,
  receiptsGet,
  remember,
} from "./memories.ts";
import { personalCollectionId } from "./memory-files.ts";
import { preparePurge, purge } from "./purge.ts";
import type { OnErase } from "./purge.ts";
import { recall } from "./recall.ts";
import { search } from "./search.ts";
import { catalog, follow, read } from "./tools.ts";
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
  rewrite: async (by, rewrite) => {
    for (const each of copies) {
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
 * What a purge reaches of core's own (purge.ts `OnErase`): the brain's gap
 * answers and records, the originals of uploaded files, the Apps
 * collection's entries and each person's Personal collection.
 */
const coreErasure = (env: Env): OnErase => ({
  ...allOf([gapAnswerErasure(env), brainRecordErasure(env)]),
  ...uploadErasure(env),
  ...appsErasure(env),
  personalCollection: personalCollectionId,
});

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
      async (reader) => await remember(this.#env, reader, input, options)
    );
  }

  async receiptsGet(input: ReceiptsGetInput): Promise<CommandReceipt> {
    return await this.#asReader(
      async (reader) => await receiptsGet(this.#env, reader, input)
    );
  }

  async memoriesGet(input: MemoriesGetInput): Promise<MemoryRecord> {
    return await this.#asReader(
      async (reader) => await memoriesGet(this.#env, reader, input)
    );
  }

  async memoriesList(input?: MemoriesListInput): Promise<MemoryPage> {
    return await this.#asReader(
      async (reader) => await memoriesList(this.#env, reader, input)
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
        await listDocuments(this.#env, reader, collectionId, options)
    );
  }

  async getDocument(
    documentId: string,
    version?: number
  ): Promise<DocumentRead> {
    return await this.#asReader(
      async (reader) =>
        await getDocument(this.#env, reader, documentId, version)
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
      async (reader) => await history(this.#env, reader, documentId, options)
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
      async (reader) => await backlinks(this.#env, reader, documentId, options)
    );
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResults> {
    return await this.#asReader(
      async (reader) => await search(this.#env, reader, query, options)
    );
  }

  async recall(input: RecallInput): Promise<MemoryPack> {
    return await this.#asReader(
      async (reader) => await recall(this.#env, reader, input)
    );
  }

  async catalog(): Promise<KnowledgeCatalog> {
    return await this.#asReader(
      async (reader) => await catalog(this.#env, reader)
    );
  }

  async read(
    documentId: string,
    options?: ReadOptions
  ): Promise<KnowledgeRead> {
    return await this.#asReader(
      async (reader) => await read(this.#env, reader, documentId, options)
    );
  }

  async follow(documentId: string): Promise<FollowResult> {
    return await this.#asReader(
      async (reader) => await follow(this.#env, reader, documentId)
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
          this.#env,
          purgerOf(person),
          input,
          coreErasure(this.#env)
        )
    );
  }

  async purge(input: PurgeInput, token: string): Promise<PurgeResult> {
    return await withPerson(
      this.#check,
      async (person) =>
        await purge(
          this.#env,
          purgerOf(person),
          input,
          token,
          coreErasure(this.#env)
        )
    );
  }
}
