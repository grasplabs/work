import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import { packAcross } from "./across.ts";
import { bucketUnder } from "./bucket.ts";
import type { BrainBucket } from "./bucket.ts";
import {
  currentRequestSchema,
  embedModelSchema,
  erasureLookupSchema,
  newInstructionsSchema,
  newSourceSchema,
  personErasureSchema,
  storeKindOf,
  recallRequestSchema,
  sourceErasureSchema,
  sourceListRequestSchema,
  vectorSearchSchema,
  vectorsToPutSchema,
  versionListRequestSchema,
  versionRequestSchema,
} from "./contract.ts";
import type {
  AskModel,
  CurrentRequest,
  Embedders,
  ErasureReason,
  Finding,
  ErasureLookup,
  ErasureStatus,
  NewInstructions,
  Reader,
  Access,
  StoreKind,
  NewSource,
  PersonErasure,
  RecallRequest,
  Pack,
  SourceErasure,
  SourceList,
  SourceListRequest,
  SourceVersion,
  SourceVersionRef,
  StaffActionOutcome,
  VectorSearch,
  VectorsFound,
  VectorsToPut,
  VersionList,
  VersionListRequest,
  VersionRequest,
  WorkOverview,
} from "./contract.ts";
import migrations from "./db/migrations/migrations.js";
import {
  embeddingDue,
  embeddingOverview,
  embeddingStep,
  reembed,
} from "./embedding.ts";
import {
  confirmPending,
  deleteStoreObjects,
  erase,
  eraseBatch,
  erasureStatusOf,
  erasuresOverview,
  erasureDue,
  erasuresUnfinished,
  isStoreErased,
  storeErasedAt,
  keepMissingSubjects,
  ledgerPrefix,
  readLedgerStart,
  recordStoreErased,
  replayStep,
  subjectOf,
  sourcesWithoutCurrent,
} from "./erasure.ts";
import type { ErasureStore } from "./erasure.ts";
import {
  fileGraceMs,
  filesPrefix,
  hashOf,
  sweepDueAt,
  sweepFiles,
  vectorsPrefix,
} from "./files.ts";
import { listSources, listVersions } from "./listing.ts";
import {
  countingInto,
  countWithoutMeaning,
  newRecallCounts,
  recallOverviewOf,
} from "./recall-counts.ts";
import { find, recall } from "./recall.ts";
import { addVersion, readCurrent, readVersion } from "./sources.ts";
import type { SourcesStore } from "./sources.ts";
import {
  putVectors,
  repackDue,
  repackVectors,
  searchVectors,
} from "./vectors.ts";
import {
  markWordsCurrentIfEmpty,
  reindexWords,
  startWordsRebuild,
  wordsRebuilding,
} from "./words.ts";
import {
  newWorkState,
  queueDueAt,
  releaseInterrupted,
  repackPerTick,
  requeueWork,
  stopWorkOn,
  workOverview,
  workTick,
} from "./work.ts";

/** What a person's own store's alarm works with (`BrainStore.alarmHost`). */
export interface AlarmHost {
  ask: AskModel;
  embedders: Embedders;
}

/** What the store needs of its host's Worker: the Brain's bucket. */
export interface BrainStoreEnv {
  /** Where the original files of source versions are kept (files.ts). */
  readonly BRAIN_OBJECTS: R2Bucket;
}

/**
 * `input` as `schema` reads it, or an error that says why not: its paths
 * and the rules they broke, never the values. A ZodError itself reaches
 * the host over RPC as no more than its name.
 */
const checked = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`The Brain refused it: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

/** How long sweeping waits after a sweep that timed out or failed. */
const sweepWaitMs = 15 * 60_000;

/**
 * What every call but the overview answers while the store can't read
 * its erasure ledger: it serves nothing it may have erased.
 */
const ledgerUnreadable =
  "The Brain can't read its erasure ledger yet, so it answers nothing: try again shortly";

/**
 * What every call but the overview answers while a long replay of the
 * erasure ledger is under way, after a restore: each call goes on with it.
 */
const ledgerCatchingUp =
  "The Brain is applying its erasure ledger after a restore, so it answers nothing yet: try again shortly";

/** How long after a failed read of the ledger a call reads it again. */
const ledgerRetryMs = 30_000;

/**
 * The soonest a person's own store wakes itself again (`alarm`): a
 * minute, as the host's clock ticks the shared store.
 */
const alarmWaitMs = 60_000;

/** A tick's time: a valid date. */
const tickAtSchema = z.date();

/** An item of the queue, by its id. */
const workIdSchema = z.int().positive();

/** What a person's own store answers a reader who is not that person. */
const notTheirs =
  "The Brain refused it: this store answers only the person whose it is";

/** What a person's own store answers an add anyone else may read. */
const notTheirsAlone =
  "The Brain refused it: this store keeps only what its person alone may read";

/** What a store whose name says no one's answers every call. */
const noOnes =
  "The Brain refused it: this store's name doesn't say whose it is";

/** What a person's own store answers once it was erased whole. */
const erasedWhole = "The Brain refused it: this store was erased";

/**
 * What a call that changed a person's own store answers when it could not
 * set when the store wakes for what it left: done, but to repeat.
 */
const alarmUnset =
  "The Brain did it but couldn't schedule what it left to finish: try again";

/** What erasing a person's own store answers while files are left to delete. */
const stillDeleting =
  "The Brain erased this store and is still deleting its files: erase it again";

/** What erasing a person's own store answers when its record couldn't be written. */
const erasureUnrecorded =
  "The Brain could not record the erasure: erase it again";

/** What a store that holds nothing finds: nothing, by every way. */
const nothingFound: Finding = {
  words: [],
  stopWords: [],
  terms: [],
  exact: [],
  capped: [],
  meaning: [],
};

const encoder = new TextEncoder();

/**
 * Where in the host's bucket the store of `kind` keeps its objects
 * (bucket.ts): a shared store at the root, a person's own under the
 * SHA-256 of their id.
 */
const prefixOf = async (kind: StoreKind): Promise<string> =>
  kind.kind === "person"
    ? `people/${await hashOf(encoder.encode(kind.person))}/`
    : "";

/** Whether the store's schema was ever made: a person's own store makes it at its first write. */
const hasSchema = (sql: SqlStorage): boolean =>
  sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_versions'"
    )
    .toArray().length > 0;

/**
 * The Brain's store: its sources and their versions, who may read them
 * and their words, in the object's own SQLite, with each version's
 * original file in the host's Brain bucket. Its public methods are the
 * contract (contract.ts `Brain`), and they are all there is: nothing else
 * can read its storage. Each checks what it is given, so nothing
 * malformed is stored or asked; who the reader is, is the host's to say.
 *
 * One class, two kinds of store, told apart by the object's name alone
 * (contract.ts `storeKindOf`):
 *
 * - The shared store (`brainOf`): what more than one person may read.
 * - A person's own store (`personalBrainOf`, named by their id): what
 *   only they may read. It keeps nothing anyone else may read, answers no
 *   other reader, keeps its files under a prefix of its own (bucket.ts),
 *   makes its schema only at its first write, and is erased whole: then
 *   it deletes itself and refuses every call, also after a restore of
 *   its storage (erasure.ts `isStoreErased`). Which person's store a
 *   call reaches is the host's to say, from the person it verified: the
 *   store checks every call against its own name, so a reader, an owner
 *   or an erasure of anyone else is refused, never answered.
 *
 * A store whose id has no name refuses every call: it can't say whose it
 * is.
 */
export class BrainStore extends DurableObject<BrainStoreEnv> {
  readonly #db = drizzle(this.ctx.storage);

  /**
   * Whose the store is, by its name (contract.ts `storeKindOf`): shared,
   * or one person's own, which keeps only what they alone may read,
   * answers only them, and is erased whole; or no one's, refusing every
   * call.
   */
  readonly #kind = storeKindOf(this.ctx.id.name);

  /** Where the store's part of the host's bucket is (bucket.ts), once known. */
  #prefix: string | undefined;

  /**
   * Whether the store's schema is made, as this instance's start found or
   * made it (`#start`): false until then, so nothing reads a table that
   * may not exist (a person's store that couldn't read whether it was
   * erased stops before it looks). A person's own store makes it at its
   * first write, so a person who never had anything kept costs no
   * storage: until then every read answers that nothing is there.
   */
  #schema = false;

  /** Whether this person's own store was erased whole: then it refuses every call. */
  #erased = false;

  /**
   * The calls under way that may write to the store's part of the bucket:
   * every call that can change it (`#changing`).
   */
  readonly #writes = new Set<Promise<unknown>>();

  /** Whether this instance made its schema current (`#start`). */
  #opened = false;

  /**
   * The tick's steps' last failures, cleared by a later success, and the
   * time before which no sweep runs again: in memory, gone with the
   * instance.
   */
  readonly #stepsFailed: WorkOverview["stepsFailed"] = {
    ledger: null,
    erase: null,
    sweep: null,
    repack: null,
    reindex: null,
    embedding: null,
  };
  #sweepAfter = 0;

  /**
   * Recall by each way and without meaning, since this instance started:
   * in memory, gone with it, as `#stepsFailed` (recall-counts.ts).
   */
  readonly #recallCounts = newRecallCounts();

  /**
   * Where this instance is with its erasure ledger: read through, a replay
   * under way, or the last read failed. What the gate (`#ready`) and the
   * overview both read.
   */
  #ledger: WorkOverview["ledgerReplay"] = "replaying";

  /** When a call may read the ledger again, after a read that failed. */
  #ledgerRetryAfter = 0;

  /** This instance's state of its work queue: gone with it. */
  readonly #work = newWorkState(() => {
    // Only once what it wrote is on disk: an abort drops the writes not
    // yet confirmed, the settles of the handlers it is to end among them.
    // A flush that fails still ends in the restart. The restart also ends
    // whatever else the store is doing then: an add, a read or a vector
    // put under way fails and its caller retries; a write such a call made
    // after the flush is dropped whole, never half; nothing acknowledged
    // is lost.
    void (async () => {
      try {
        await this.ctx.storage.sync();
      } finally {
        this.ctx.abort("Handlers past their time held up the queue");
      }
    })();
  });

  constructor(ctx: DurableObjectState, env: BrainStoreEnv) {
    super(ctx, env);
    // The schema is current, what an earlier instance had under way put
    // back in the queue, and every erasure in the ledger applied (an older
    // copy of the store may have come back), before the object handles
    // anything. A ledger out of reach leaves the store answering nothing
    // but its overview, each call refused with why, until a later call
    // reads it (`#ready`).
    void ctx.blockConcurrencyWhile(async () => {
      if (this.#kind.kind === "unknown") {
        return;
      }
      this.#prefix = await prefixOf(this.#kind);
      await this.#start(false);
      // What an earlier instance left (a write cut off by a reset, what
      // this start's replay hid) wakes this one: nothing else would.
      await this.#armQuietly();
    });
  }

  /**
   * The store started, while it takes nothing else, and again by each call
   * until it is (`#ledgerStep`): a person's own store first reads whether
   * it was erased whole, and if so deletes whatever came back (a restore
   * of its storage) before anything else, and answers nothing from then
   * on. Then the schema made current, what an earlier instance had under
   * way put back in the queue, and the ledger read (`#readLedger`). A
   * person's own store whose schema was never made makes none unless
   * `create` (its first write, `#readyToWrite`): until then it holds
   * nothing and writes nothing. A failure to read whether it was erased
   * is kept as the ledger's, never thrown.
   */
  async #start(create: boolean): Promise<void> {
    if (this.#kind.kind === "person") {
      try {
        if (await isStoreErased(this.#bucket)) {
          if (!this.#erased) {
            await this.#forget();
          }
          this.#ledger = "through";
          return;
        }
      } catch {
        // Nothing of the error is kept.
        this.#ledger = "unreadable";
        return;
      }
    }
    if (!this.#opened) {
      if (this.#kind.kind === "person" && !hasSchema(this.ctx.storage.sql)) {
        if (!create) {
          this.#schema = false;
          this.#ledger = "through";
          return;
        }
        // Its ledger read before any table is made: a store that can't
        // read it makes nothing.
        try {
          await readLedgerStart(this.#bucket);
        } catch {
          // Nothing of the error is kept.
          this.#ledger = "unreadable";
          return;
        }
      }
      await migrate(this.#db, migrations);
      releaseInterrupted(this.ctx.storage);
      markWordsCurrentIfEmpty(this.ctx.storage.sql);
      await keepMissingSubjects(this.ctx.storage);
      this.#opened = true;
      this.#schema = true;
    }
    await this.#readLedger();
  }

  /**
   * The store's part of the host's bucket, as the env has it now: known
   * before any call is taken.
   */
  get #bucket(): BrainBucket {
    if (this.#prefix === undefined) {
      throw new Error(noOnes);
    }
    return bucketUnder(this.env.BRAIN_OBJECTS, this.#prefix);
  }

  /**
   * Everything the store holds deleted, as a person's store erased whole:
   * it refuses every call from then on. Run while the store takes nothing
   * else.
   */
  async #forget(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#erased = true;
    this.#schema = false;
  }

  /**
   * Refuses a call to a store whose name says no one's, and ends this
   * instance: an id reached once without its name (`idFromString`) makes
   * an instance that can't know whose it is, and the next call, by name,
   * gets an instance of its own that can. The instance is ended before
   * the refusal is thrown, which ends this call with the same words.
   */
  #refuseNoOnes(): never {
    this.ctx.abort(noOnes);
    throw new Error(noOnes);
  }

  /** Refuses `reader` on a person's own store unless they are that person. */
  #mayRead(reader: Reader): void {
    if (this.#kind.kind === "person" && reader.person !== this.#kind.person) {
      throw new Error(notTheirs);
    }
  }

  /** Refuses `access` on a person's own store unless it is that person's alone. */
  #mayKeep(access: Access): void {
    if (
      this.#kind.kind === "person" &&
      (access.kind !== "owner" || access.person !== this.#kind.person)
    ) {
      throw new Error(notTheirsAlone);
    }
  }

  /**
   * One step of reading the erasure ledger and applying what the store
   * lacks (erasure.ts `replayStep`: one page, done well inside the 30 s the
   * store may be held); read through once nothing is left. A failure is
   * kept, never thrown, as a throw here would reset the store; what a step
   * applied stays applied. Run while the store takes nothing else.
   */
  async #readLedger(): Promise<void> {
    try {
      const { stopped, more } = await replayStep(this.#erasures);
      stopWorkOn(this.#work, stopped);
      this.#ledger = more ? "replaying" : "through";
    } catch {
      // Nothing of the error is kept: it may name a key.
      this.#ledger = "unreadable";
    }
  }

  /**
   * Resolves once this instance has read its erasure ledger through. Until
   * then each call (a tick's among them) reads one more step while the
   * store takes nothing else, and is refused with why: the ledger can't
   * be read, or a long replay is under way (the overview says which).
   * Every call but the overview waits for it.
   */
  async #ready(): Promise<void> {
    if (this.#kind.kind === "unknown") {
      this.#refuseNoOnes();
    }
    // Read after the step, which may have changed it.
    const now = await this.#ledgerStep();
    if (this.#erased) {
      throw new Error(erasedWhole);
    }
    if (now !== "through") {
      throw new Error(
        now === "replaying" ? ledgerCatchingUp : ledgerUnreadable
      );
    }
  }

  /**
   * Where the store is with its erasure ledger, once one more step of
   * reading it was taken while it isn't read through (`#ready`'s step).
   */
  async #ledgerStep(): Promise<WorkOverview["ledgerReplay"]> {
    // After a failed read, read again at most every `ledgerRetryMs`: calls
    // between are refused at once, so an outage of R2 holds no caller
    // waiting for it.
    if (this.#ledger !== "through" && Date.now() >= this.#ledgerRetryAfter) {
      await this.ctx.blockConcurrencyWhile(async () => {
        if (this.#ledger === "through") {
          return;
        }
        await this.#start(false);
        if (this.#ledger === "unreadable") {
          this.#ledgerRetryAfter = Date.now() + ledgerRetryMs;
        }
        // A replay may have hidden versions to delete, from a read.
        await this.#armQuietly();
      });
    }
    return this.#ledger;
  }

  /**
   * As `#ready`, for a read by a reader `#mayRead` let through: whether
   * the store holds anything to read. A person's own store erased whole
   * holds nothing, and answers as a store that never held anything does:
   * its person reads after their erasure what nothing gives.
   */
  async #readable(): Promise<boolean> {
    if (await this.#erasedWhole()) {
      return false;
    }
    await this.#ready();
    return this.#schema;
  }

  /** Whether this is a person's own store erased whole, once its ledger step is taken. */
  async #erasedWhole(): Promise<boolean> {
    if (this.#kind.kind !== "person") {
      return false;
    }
    await this.#ledgerStep();
    return this.#erased;
  }

  /**
   * As `#ready`, for a call that writes: a person's own store whose schema
   * was never made makes it first, while it takes nothing else.
   */
  async #readyToWrite(): Promise<void> {
    await this.#ready();
    if (this.#schema) {
      return;
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.#schema && !this.#erased) {
        await this.#start(true);
      }
    });
    await this.#ready();
    // Made only once its ledger was read (`#start`): until then, a store
    // that holds nothing answers reads as such, and refuses a write.
    if (!this.#schema) {
      throw new Error(ledgerUnreadable);
    }
  }

  /** The parts erasure.ts works with: the store's part of the bucket. */
  get #erasures(): ErasureStore {
    return { storage: this.ctx.storage, bucket: this.#bucket };
  }

  /** The parts sources.ts works with: the store's part of the bucket. */
  get #sources(): SourcesStore {
    return {
      storage: this.ctx.storage,
      db: this.#db,
      bucket: this.#bucket,
    };
  }

  /**
   * Adds a version of a source: its file, then the version, its readers,
   * chunks and words, in one transaction, visible only once whole. The
   * same text and readers as the current version answer with it.
   */
  async addSource(source: NewSource): Promise<SourceVersionRef> {
    const adding = checked(newSourceSchema, source);
    this.#mayKeep(adding.access);
    return await this.#changing(async () => {
      await this.#readyToWrite();
      return await addVersion(this.#sources, adding, { indexed: true });
    });
  }

  /**
   * Adds a version of an instruction file, as `addSource` does, kept
   * whole: no chunks, no words, so recall never finds it.
   */
  async addInstructions(source: NewInstructions): Promise<SourceVersionRef> {
    const adding = checked(newInstructionsSchema, source);
    this.#mayKeep(adding.access);
    return await this.#changing(async () => {
      await this.#readyToWrite();
      return await addVersion(this.#sources, adding, { indexed: false });
    });
  }

  /**
   * `change` run as a call that may change the store: counted among the
   * calls under way, which may write to its part of the bucket
   * (`#eraseWhole` waits for them), and, once it ends, done or failed, a
   * person's own store's alarm set from what it then has to do
   * (`#armAlarm`). Every method that can leave work for a tick runs
   * through here, so none can leave it without the store waking for it:
   * a person's store has no clock but its own alarm.
   */
  async #changing<T>(change: () => Promise<T>): Promise<T> {
    const running = change();
    this.#writes.add(running);
    let outcome: { done: true; value: T } | { done: false; error: unknown };
    try {
      outcome = { done: true, value: await running };
    } catch (error) {
      outcome = { done: false, error };
    } finally {
      this.#writes.delete(running);
    }
    // The call's own answer stands: a failure to arm never replaces it,
    // and never reaches the caller in its own words.
    const armed = await this.#armQuietly();
    if (!outcome.done) {
      throw outcome.error;
    }
    if (!armed) {
      throw new Error(alarmUnset);
    }
    return outcome.value;
  }

  /**
   * `#armAlarm`, its failure kept from the caller: whether it armed (or
   * had nothing to arm). Nothing of the error is kept: it may be the
   * database's own words.
   */
  async #armQuietly(): Promise<boolean> {
    try {
      await this.#armAlarm();
      return true;
    } catch {
      return false;
    }
  }

  /** A pack of what the reader may read for the question, within its budget. */
  async recall(request: RecallRequest): Promise<Pack> {
    const asked = checked(recallRequestSchema, request);
    this.#mayRead(asked.reader);
    const readable = await this.#readable();
    this.#countWithoutMeaning(asked);
    return readable
      ? recall(this.ctx.storage.sql, asked, countingInto(this.#recallCounts))
      : packAcross(asked.question, asked.budget.tokens, [nothingFound]);
  }

  /**
   * What `recall` finds, before it is packed (across.ts `packAcross`),
   * each way counted as `recall` counts it.
   */
  async find(request: RecallRequest): Promise<Finding> {
    const asked = checked(recallRequestSchema, request);
    this.#mayRead(asked.reader);
    const readable = await this.#readable();
    this.#countWithoutMeaning(asked);
    return readable
      ? find(this.ctx.storage.sql, asked, countingInto(this.#recallCounts))
      : nothingFound;
  }

  /** A recall the host made without the question's vector, counted by why. */
  #countWithoutMeaning({ withoutMeaning }: RecallRequest): void {
    if (withoutMeaning !== undefined) {
      countWithoutMeaning(this.#recallCounts, withoutMeaning);
    }
  }

  /** A version, current or history, whole: if the reader may read it. */
  async readVersion(request: VersionRequest): Promise<SourceVersion | null> {
    const asked = checked(versionRequestSchema, request);
    this.#mayRead(asked.reader);
    return (await this.#readable())
      ? await readVersion(this.#sources, asked)
      : null;
  }

  /** The current versions of sources, whole: those the reader may read. */
  async readCurrent(request: CurrentRequest): Promise<SourceVersion[]> {
    const asked = checked(currentRequestSchema, request);
    this.#mayRead(asked.reader);
    return (await this.#readable())
      ? await readCurrent(this.#sources, asked)
      : [];
  }

  /**
   * A page of the sources the reader may read, newest first: none in a
   * store that holds nothing (never written, or erased whole).
   */
  async listSources(request: SourceListRequest): Promise<SourceList> {
    const asked = checked(sourceListRequestSchema, request);
    this.#mayRead(asked.reader);
    return (await this.#readable())
      ? listSources(this.ctx.storage.sql, asked)
      : { sources: [], more: false };
  }

  /**
   * A page of the versions of a source the reader may read, newest first:
   * none in a store that holds nothing (never written, or erased whole).
   */
  async listVersions(request: VersionListRequest): Promise<VersionList> {
    const asked = checked(versionListRequestSchema, request);
    this.#mayRead(asked.reader);
    return (await this.#readable())
      ? listVersions(this.ctx.storage.sql, asked)
      : { versions: [], more: false };
  }

  /**
   * Erases a source for good (erasure.ts): recorded in the ledger and
   * hidden before it returns, deleted by its tick if not at once. Work
   * under way on it is stopped (work.ts `stopWorkOn`). A person's own
   * store erased whole holds nothing to erase: done, so a caller erasing
   * that person's sources after them isn't held pending for good.
   */
  async eraseSource(request: SourceErasure): Promise<void> {
    const { source, reason } = checked(sourceErasureSchema, request);
    if (await this.#erasedWhole()) {
      return;
    }
    await this.#changing(async () => {
      await this.#readyToWrite();
      await erase(this.#erasures, "source", source, reason, (sources) => {
        stopWorkOn(this.#work, sources);
      });
    });
  }

  /**
   * Erases what only one person may read (erasure.ts), as `eraseSource`
   * erases a source. A person's own store erases itself whole, and only
   * for that person (`#eraseWhole`).
   */
  async erasePerson(request: PersonErasure): Promise<void> {
    const { person, reason } = checked(personErasureSchema, request);
    if (this.#kind.kind === "person") {
      if (person !== this.#kind.person) {
        throw new Error(notTheirs);
      }
      await this.#eraseWhole(reason);
      return;
    }
    await this.#ready();
    await erase(this.#erasures, "person", person, reason, (sources) => {
      stopWorkOn(this.#work, sources);
    });
  }

  /**
   * This person's own store erased whole (erasure.ts): the record of it
   * written first, then all the store holds deleted, while it takes
   * nothing else, so from then on it refuses every call, also after a
   * restore of its storage or when a late add wakes it. Then its files
   * and vectors, a bounded batch a call: until none is left it throws
   * `stillDeleting`, so the caller keeps its erasure pending and calls
   * again. Safe to repeat. Throws, deleting nothing, when the record
   * couldn't be written.
   */
  async #eraseWhole(reason: ErasureReason): Promise<void> {
    if (!this.#erased) {
      const recorded = await this.ctx.blockConcurrencyWhile(async () => {
        if (this.#erased) {
          return true;
        }
        try {
          await recordStoreErased(this.#bucket, reason, Date.now());
        } catch {
          // Nothing of the error is kept: nothing is deleted.
          return false;
        }
        await this.#forget();
        return true;
      });
      if (!recorded) {
        throw new Error(erasureUnrecorded);
      }
    }
    // An add, a source's erasure or a tick that started before this may
    // still write a file, a vector or a ledger entry under the store's
    // prefix after this deletes what it lists. While one is under way in
    // this instance, the erasure isn't finished. Nor is it while one that
    // an earlier instance started (reset meanwhile, so no longer seen
    // here) may still land: until the grace an add has to write its file
    // (files.ts `fileGraceMs`) has passed since the record. Both are read
    // before the listing, so what lands after it is deleted by a later
    // call: the caller calls again until one is done.
    const quiet = this.#writes.size === 0;
    let done = false;
    try {
      const at = await storeErasedAt(this.#bucket);
      const settled = at !== null && Date.now() - at >= fileGraceMs;
      const emptied = await deleteStoreObjects(this.#bucket, [
        filesPrefix,
        vectorsPrefix,
        ledgerPrefix,
      ]);
      done = quiet && settled && emptied;
    } catch {
      // Nothing of the error is kept: it may name a key.
    }
    if (!done) {
      throw new Error(stillDeleting);
    }
  }

  /**
   * Whether a source or a person was erased, from this store's record of
   * its ledger alone (erasure.ts `erasureStatusOf`, by the SHA-256 the
   * ledger names it by). A read: it changes nothing and leaves no work.
   * Refused, as every call is, by a store whose name says no one's;
   * `unavailable` while the ledger can't be read or is being replayed (the
   * gate `#ready` throws for, answered instead). A person's own store
   * never written, or erased whole, holds no record: `not_erased`, without
   * a table read. Staff ask the shared store alone: no staff path
   * addresses a person's own store (GRA-1762).
   */
  async erasureStatus(request: ErasureLookup): Promise<ErasureStatus> {
    if (this.#kind.kind === "unknown") {
      this.#refuseNoOnes();
    }
    const lookup = checked(erasureLookupSchema, request);
    const subject = await subjectOf(
      lookup.kind === "source" ? lookup.source : lookup.person
    );
    const ledger = await this.#ledgerStep();
    if (ledger !== "through") {
      return { state: "unavailable" };
    }
    // The gate, then the record, with no await between.
    if (!this.#schema) {
      return { state: "not_erased" };
    }
    return erasureStatusOf(this.ctx.storage.sql, lookup.kind, subject);
  }

  /**
   * One tick of the host's clock at `at`: the erasure ledger's entries
   * not yet written written, then one batch of what erasures still hold
   * deleted, then one batch of the sweep, then up
   * to `repackPerTick` blocks of vector codes repacked, then, while the
   * word indexes are behind their rules, one batch of them rebuilt, then
   * a step of embedding (embedding.ts), then the queue, asking `ask` for
   * its model calls and `embedders` for vectors (work.ts). Each step is
   * bounded, so
   * none starves the next, and the queue runs whatever the others did.
   */
  async work(ask: AskModel, at: Date, embedders: Embedders): Promise<void> {
    await this.#changing(async () => {
      await this.#workNow(ask, at, embedders);
    });
  }

  /** `work`, as one of the calls that may write to the bucket. */
  async #workNow(ask: AskModel, at: Date, embedders: Embedders): Promise<void> {
    await this.#ready();
    const tickAt = checked(tickAtSchema, at);
    const model = checked(embedModelSchema.nullable(), embedders.model);
    if (!this.#schema) {
      // Nothing was ever kept: nothing to do.
      return;
    }
    await this.#tick(ask, tickAt, {
      model,
      embed: async (request) => await embedders.embed(request),
    });
  }

  /** The tick of `work` at `tickAt`, with the host's checked `embedders`. */
  async #tick(
    ask: AskModel,
    tickAt: Date,
    embedders: Embedders
  ): Promise<void> {
    if (this.#work.restarting) {
      // The store restarts in a moment: the next instance's tick works.
      return;
    }
    await this.#confirm(tickAt);
    this.#erase(tickAt);
    await this.#sweep(tickAt);
    this.#repack(tickAt);
    this.#reindex(tickAt);
    this.#embedding(tickAt, embedders.model);
    await workTick(
      this.ctx.storage,
      this.#work,
      { ask, embedders, bucket: this.#bucket },
      tickAt
    );
  }

  /**
   * What the store's own alarm works with: the host's model calls and
   * embedders, as its clock gives them to the shared store's tick. The
   * host's subclass gives them; null, as here, works nothing on an alarm.
   * A field, not a method: no caller reaches it over RPC, which exposes
   * only the class's methods.
   */
  protected readonly alarmHost: (() => Promise<AlarmHost>) | null = null;

  /**
   * A person's own store's tick, on the alarm it set itself (`#armAlarm`):
   * the host's clock ticks only the shared store, so each person's store
   * wakes itself while it has work, and sleeps, costing nothing, once it
   * has none. Its tick sets the next.
   */
  override async alarm(): Promise<void> {
    if (this.#kind.kind === "unknown") {
      // Ended as every call to it is (`#refuseNoOnes`): the runtime retries
      // the alarm on an instance of its own.
      this.ctx.abort(noOnes);
      return;
    }
    if (this.#kind.kind !== "person") {
      return;
    }
    try {
      // An erased store wakes to nothing (`#ready` would refuse the tick).
      await this.#ledgerStep();
      if (this.#erased) {
        return;
      }
      if (this.alarmHost !== null) {
        const host = await this.alarmHost();
        await this.work(host.ask, new Date(), host.embedders);
      }
    } catch {
      // Nothing of the error is kept. A tick that couldn't run (its ledger
      // unreadable or still replaying, the host's model unreachable) wakes
      // the store again in a minute, until it can: never only after the
      // runtime's own retries, which give up.
      await this.#armAgain();
    }
  }

  /**
   * A person's own store's alarm set a minute on, unless one is set
   * sooner, whatever work it holds: after a tick that couldn't run.
   */
  async #armAgain(): Promise<void> {
    if (this.#erased) {
      return;
    }
    const at = Date.now() + alarmWaitMs;
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /**
   * When a tick next has something to do, in milliseconds, or null when
   * nothing is left: the one rule of whether this store has work, made of
   * each step's own rule, beside the code that decides that step (`#tick`,
   * in its order):
   *
   * - erasure.ts `erasureDue`: a ledger entry to write, hidden versions to
   *   delete;
   * - files.ts `sweepDueAt`: a file or a vector nothing holds, once its
   *   grace is over, and the sweep's own wait after a failure;
   * - vectors.ts `repackDue`: removed codes to repack;
   * - words.ts `wordsRebuilding`: word indexes behind their rules;
   * - embedding.ts `embeddingDue`: a walk not over, or a replaced build
   *   still to remove;
   * - work.ts `queueDueAt`: an item of the queue, due or coming back from
   *   parked, once the queue's pause is over.
   *
   * A step that keeps failing stays due, so the store keeps waking for it
   * while staff see the failure in the overview.
   */
  #nextWorkAt(now: number): number | null {
    const { storage } = this.ctx;
    const { sql } = storage;
    if (
      erasureDue(sql) ||
      repackDue(sql) ||
      wordsRebuilding(sql) ||
      embeddingDue(storage)
    ) {
      return now;
    }
    const sweep = sweepDueAt(sql);
    const due = [
      sweep === null ? null : Math.max(sweep, this.#sweepAfter),
      queueDueAt(storage),
    ].filter((at) => at !== null);
    return due.length === 0 ? null : Math.min(...due);
  }

  /**
   * A person's own store's alarm set for when a tick next has something
   * to do (`#nextWorkAt`), a minute on at the soonest, unless one is set
   * sooner; none when nothing is left, or the store holds nothing. Run
   * after every call that can change the store (`#changing`).
   */
  async #armAlarm(): Promise<void> {
    if (this.#kind.kind !== "person" || !this.#schema || this.#erased) {
      return;
    }
    const now = Date.now();
    const due = this.#nextWorkAt(now);
    if (due === null) {
      return;
    }
    const at = Math.max(due, now + alarmWaitMs);
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /**
   * The tick's step of embedding (embedding.ts): a failure ends it and
   * never reaches the queue; it is tried again next tick, and the overview
   * shows when it last failed until a later step runs through, as the
   * repack's and the reindex's.
   */
  #embedding(at: Date, model: Embedders["model"]): void {
    try {
      embeddingStep(this.ctx.storage, model);
      this.#stepsFailed.embedding = null;
    } catch {
      // Nothing of the error is kept.
      this.#stepsFailed.embedding = { at, reason: "failed" };
    }
  }

  /**
   * Puts every current version whose chunks lack vectors of the host's
   * model on the queue again, over the next ticks (embedding.ts):
   * `nothing` while no model was seen; during a walk, it starts the walk
   * over; `unavailable`, changing nothing, until the ledger is read
   * through.
   */
  async reembed(): Promise<StaffActionOutcome> {
    return await this.#changing(async () => {
      if (!(await this.#actionable())) {
        return "unavailable";
      }
      return this.#schema && reembed(this.ctx.storage) ? "done" : "nothing";
    });
  }

  /**
   * The ledger entries of erasures recorded but not yet written, written
   * (erasure.ts `confirmPending`): an erasure whose write failed or timed
   * out. A failure is kept in the overview until a tick writes them all.
   */
  async #confirm(at: Date): Promise<void> {
    try {
      await confirmPending(this.#erasures);
      this.#stepsFailed.ledger = null;
    } catch {
      // Nothing of the error is kept: it may name a key.
      this.#stepsFailed.ledger = { at, reason: "failed" };
    }
  }

  /**
   * One batch of the versions erasures hid, each deleted with everything
   * it holds in a transaction of its own (erasure.ts `eraseBatch`), so a
   * failure or a stop leaves it hidden and whole. First in the tick but
   * the ledger, so the files it lets go are swept the same tick when due.
   * A version that fails goes behind the others and is tried again; the
   * overview shows the failure until a batch deletes all it takes. Never
   * parked: an erasure must finish.
   */
  #erase(at: Date): void {
    try {
      const { failed } = eraseBatch(this.ctx.storage);
      this.#stepsFailed.erase = failed ? { at, reason: "failed" } : null;
    } catch {
      // Nothing of the error is kept: the batch stays to do.
      this.#stepsFailed.erase = { at, reason: "failed" };
    }
  }

  /**
   * Up to `repackPerTick` blocks of vector codes repacked, each in its own
   * transaction, so one that fails leaves the block as it was. A failure
   * ends this tick's repacking and never reaches the queue: the lowest
   * marked block is taken first, so one that keeps failing would
   * otherwise stop the queue every tick. It is tried again next tick, and
   * the overview shows when it last failed until one succeeds. So a block
   * that fails every time holds back the repacking of the blocks behind it
   * until it is fixed; the queue still runs, searches stay exact (removed
   * codes are skipped, only kept longer), and staff see it.
   */
  #repack(at: Date): void {
    try {
      for (let repacked = 0; repacked < repackPerTick; repacked += 1) {
        if (!this.#repackOne()) {
          break;
        }
      }
      this.#stepsFailed.repack = null;
    } catch {
      // Nothing of the error is kept: the block stays marked.
      this.#stepsFailed.repack = { at, reason: "failed" };
    }
  }

  /**
   * One batch of the rebuild of the word indexes, while they are behind
   * the rules words are indexed by (words.ts `reindexWords`: at most
   * `reindexPerTick` chunks), in one transaction with the place it
   * reached, so a failure or a stop leaves every chunk whole and the next
   * tick goes on from there. A failure never reaches the queue: it is
   * tried again next tick, and the overview shows when it last failed
   * until a batch succeeds.
   */
  #reindex(at: Date): void {
    try {
      this.ctx.storage.transactionSync(() => {
        reindexWords(this.ctx.storage.sql);
      });
      this.#stepsFailed.reindex = null;
    } catch {
      // Nothing of the error is kept: the batch stays to do.
      this.#stepsFailed.reindex = { at, reason: "failed" };
    }
  }

  /**
   * One batch of the sweep of files nothing points at (files.ts: at most
   * 100, one bulk delete in R2), while the store takes nothing else, so no
   * add notes a file the sweep is deleting. It holds the store for one R2
   * call, at most `sweepDeleteMs` (10 s), so it runs every tick when files
   * are due, and a backlog clears a hundred a minute. Nothing it throws
   * reaches the tick: inside `blockConcurrencyWhile` a throw would reset
   * the store. One that timed out or failed waits a quarter of an hour
   * before the next, so a bucket that hangs holds the store 10 s a
   * quarter of an hour at most.
   */
  async #sweep(at: Date): Promise<void> {
    if (at.getTime() < this.#sweepAfter) {
      return;
    }
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return await sweepFiles(this.ctx.storage, this.#db, this.#bucket, at);
      } catch {
        return "failed" as const;
      }
    });
    // Only a sweep that reached R2 and had its answer clears the last
    // failure; one with nothing due tells nothing of R2.
    if (outcome === "idle") {
      return;
    }
    if (outcome === "swept") {
      this.#stepsFailed.sweep = null;
      return;
    }
    this.#stepsFailed.sweep = { at, reason: outcome };
    this.#sweepAfter = at.getTime() + sweepWaitMs;
  }

  /**
   * Whether a staff action may apply: the store is someone's, its ledger
   * read through, and it wasn't erased whole.
   */
  async #actionable(): Promise<boolean> {
    if (this.#kind.kind === "unknown") {
      this.#refuseNoOnes();
    }
    return (await this.#ledgerStep()) === "through" && !this.#erased;
  }

  /** The queue, as staff see it: empty while nothing was ever kept. */
  workOverview(): WorkOverview {
    if (this.#kind.kind === "unknown") {
      this.#refuseNoOnes();
    }
    // A person's own store shows nothing of what it holds until its ledger
    // is read through: a restored copy of an erased store, started while
    // its record can't be read, would show its queue, sizes and counts.
    const unread =
      this.#kind.kind === "person" &&
      (this.#ledger !== "through" || this.#erased);
    if (!this.#schema || unread) {
      return this.#emptyOverview();
    }
    return {
      ...workOverview(this.ctx.storage, this.#work),
      erasing: erasuresUnfinished(this.ctx.storage.sql),
      ledgerReplay: this.#ledger,
      sourcesWithoutCurrent: sourcesWithoutCurrent(this.ctx.storage.sql),
      stepsFailed: { ...this.#stepsFailed },
      embedding: embeddingOverview(this.ctx.storage),
      storeBytes: this.ctx.storage.sql.databaseSize,
      words: wordsRebuilding(this.ctx.storage.sql) ? "rebuilding" : "current",
      erasures: erasuresOverview(this.ctx.storage.sql),
      recall: recallOverviewOf(this.#recallCounts),
    };
  }

  /**
   * Puts a parked item back in the queue: `nothing` when none is parked by
   * that id; `unavailable`, changing nothing, until the ledger is read
   * through (the same gate as `#ready`, answered rather than thrown).
   */
  async requeueWork(id: number): Promise<StaffActionOutcome> {
    const item = checked(workIdSchema, id);
    return await this.#changing(async () => {
      if (!(await this.#actionable())) {
        return "unavailable";
      }
      return this.#schema && requeueWork(this.ctx.storage, item)
        ? "done"
        : "nothing";
    });
  }

  /**
   * Starts a rebuild of the word indexes: `nothing` when one is under way;
   * `unavailable`, changing nothing, until the ledger is read through.
   */
  async rebuildWords(): Promise<StaffActionOutcome> {
    return await this.#changing(async () => {
      if (!(await this.#actionable())) {
        return "unavailable";
      }
      return this.#schema && startWordsRebuild(this.ctx.storage.sql)
        ? "done"
        : "nothing";
    });
  }

  /** The overview of a store that never kept anything. */
  #emptyOverview(): WorkOverview {
    return {
      waiting: [],
      running: 0,
      parked: [],
      parkedCount: 0,
      paused: null,
      overdue: [],
      erasing: 0,
      sourcesWithoutCurrent: 0,
      ledgerReplay: this.#ledger,
      stepsFailed: { ...this.#stepsFailed },
      embedding: {
        model: null,
        chunks: 0,
        embedded: 0,
        unembeddable: 0,
        parked: 0,
        rebuilt: true,
      },
      storeBytes: 0,
      words: "current",
      erasures: {
        source: { written: 0, unwritten: 0 },
        person: { written: 0, unwritten: 0 },
        byReason: { deleted: 0, retention: 0, person_erased: 0, withdrawn: 0 },
      },
      recall: recallOverviewOf(this.#recallCounts),
    };
  }

  /**
   * Keeps vectors of current chunks as their codes, in one transaction;
   * none in a store that never kept anything, which has no chunks.
   */
  async putVectors(request: VectorsToPut): Promise<void> {
    const vectors = checked(vectorsToPutSchema, request);
    await this.#changing(async () => {
      await this.#ready();
      if (!this.#schema) {
        return;
      }
      this.ctx.storage.transactionSync(() => {
        putVectors(this.ctx.storage.sql, vectors);
      });
    });
  }

  /** What the reader may read of current chunks, nearest the vector first. */
  async searchVectors(request: VectorSearch): Promise<VectorsFound> {
    const asked = checked(vectorSearchSchema, request);
    this.#mayRead(asked.reader);
    return (await this.#readable())
      ? searchVectors(this.ctx.storage.sql, asked)
      : { chunks: [] };
  }

  /** Repacks one block holding removed codes: true when more are left. */
  async repackVectors(): Promise<boolean> {
    return await this.#changing(async () => {
      await this.#ready();
      return this.#schema && this.#repackOne();
    });
  }

  /** One block repacked, in its own transaction: true when more are left. */
  #repackOne(): boolean {
    return this.ctx.storage.transactionSync(() =>
      repackVectors(this.ctx.storage.sql)
    );
  }
}
