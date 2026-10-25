import type {
  ChangeOptions,
  CommandOptions,
  MemoriesProposeChangeInput,
  MemoriesPublishInput,
  MemoriesRetireInput,
  CommandReceipt,
  MemoriesGetInput,
  MemoriesListInput,
  MemoryPack,
  MemoryPage,
  MemoryRecord,
  ReceiptsGetInput,
  RecallInput,
  RememberInput,
} from "@grasp-os/brain/contract";
import {
  backlinks,
  getDocument,
  history,
  listDocuments,
} from "@grasp-os/brain/documents";
import type { Writer } from "@grasp-os/brain/documents";
import {
  memoriesGet,
  memoriesList,
  memoriesProposeChange,
  memoriesPublish,
  memoriesRetire,
  receiptsGet,
  remember,
} from "@grasp-os/brain/memories";
import { preparePurge, purge } from "@grasp-os/brain/purge";
import type { OnErase } from "@grasp-os/brain/purge";
import { recall } from "@grasp-os/brain/recall";
import { search } from "@grasp-os/brain/search";
import { follow, read } from "@grasp-os/brain/tools";
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
import { documentReadingErasure } from "../onboarding/documents.ts";
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
 * What a purge reaches of core's own copies (purge.ts `OnErase`): the
 * brain's gap answers and records, the originals of uploaded files, the
 * onboarding's readings of the documents shared in it with what was drawn
 * from them, the Apps collection's entries and each person's Personal
 * collection.
 */
const coreErasure = (env: Env): OnErase => {
  const readings = documentReadingErasure(env);
  return {
    ...allOf([
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

  async purge(input: PurgeInput, token: string): Promise<PurgeResult> {
    return await withPerson(
      this.#check,
      async (person) =>
        await purge(
          brainOf(this.#env),
          purgerOf(person),
          input,
          token,
          coreErasure(this.#env)
        )
    );
  }
}
