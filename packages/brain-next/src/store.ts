import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import {
  currentRequestSchema,
  readableRequestSchema,
  embedModelSchema,
  newInstructionsSchema,
  newSourceSchema,
  personErasureSchema,
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
  ReadableRequest,
  Embedders,
  NewInstructions,
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
import { embeddingOverview, embeddingStep, reembed } from "./embedding.ts";
import {
  confirmPending,
  erase,
  eraseBatch,
  erasuresOverview,
  erasuresUnfinished,
  keepMissingSubjects,
  replayStep,
  sourcesWithoutCurrent,
} from "./erasure.ts";
import type { ErasureStore } from "./erasure.ts";
import { sweepFiles } from "./files.ts";
import { listSources, listVersions } from "./listing.ts";
import {
  countingInto,
  countWithoutMeaning,
  newRecallCounts,
  recallOverviewOf,
} from "./recall-counts.ts";
import { recall } from "./recall.ts";
import {
  addVersion,
  readCurrent,
  readVersion,
  readableVersions,
} from "./sources.ts";
import type { SourcesStore } from "./sources.ts";
import { putVectors, repackVectors, searchVectors } from "./vectors.ts";
import {
  markWordsCurrentIfEmpty,
  reindexWords,
  startWordsRebuild,
  wordsRebuilding,
} from "./words.ts";
import {
  newWorkState,
  releaseInterrupted,
  repackPerTick,
  requeueWork,
  stopWorkOn,
  workOverview,
  workTick,
} from "./work.ts";

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

/** A tick's time: a valid date. */
const tickAtSchema = z.date();

/** An item of the queue, by its id. */
const workIdSchema = z.int().positive();

/**
 * The Brain's store: its sources and their versions, who may read them
 * and their words, in the object's own SQLite, with each version's
 * original file in the host's Brain bucket. Its public methods are the
 * contract (contract.ts `Brain`), and they are all there is: nothing else
 * can read its storage. Each checks what it is given, so nothing
 * malformed is stored or asked; who the reader is, is the host's to say.
 */
export class BrainStore extends DurableObject<BrainStoreEnv> {
  readonly #db = drizzle(this.ctx.storage);

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
      await migrate(this.#db, migrations);
      releaseInterrupted(ctx.storage);
      markWordsCurrentIfEmpty(ctx.storage.sql);
      await keepMissingSubjects(ctx.storage);
      await this.#readLedger();
    });
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
    // Read after the step, which may have changed it.
    const now = await this.#ledgerStep();
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
        await this.#readLedger();
        if (this.#ledger === "unreadable") {
          this.#ledgerRetryAfter = Date.now() + ledgerRetryMs;
        }
      });
    }
    return this.#ledger;
  }

  /** The parts erasure.ts works with, the bucket as the env has it now. */
  get #erasures(): ErasureStore {
    return { storage: this.ctx.storage, bucket: this.env.BRAIN_OBJECTS };
  }

  /** The parts sources.ts works with, the bucket as the env has it now. */
  get #sources(): SourcesStore {
    return {
      storage: this.ctx.storage,
      db: this.#db,
      bucket: this.env.BRAIN_OBJECTS,
    };
  }

  /**
   * Adds a version of a source: its file, then the version, its readers,
   * chunks and words, in one transaction, visible only once whole. The
   * same text and readers as the current version answer with it.
   */
  async addSource(source: NewSource): Promise<SourceVersionRef> {
    await this.#ready();
    return await addVersion(this.#sources, checked(newSourceSchema, source), {
      indexed: true,
    });
  }

  /**
   * Adds a version of an instruction file, as `addSource` does, kept
   * whole: no chunks, no words, so recall never finds it.
   */
  async addInstructions(source: NewInstructions): Promise<SourceVersionRef> {
    await this.#ready();
    return await addVersion(
      this.#sources,
      checked(newInstructionsSchema, source),
      { indexed: false }
    );
  }

  /** A pack of what the reader may read for the question, within its budget. */
  async recall(request: RecallRequest): Promise<Pack> {
    await this.#ready();
    const asked = checked(recallRequestSchema, request);
    if (asked.withoutMeaning !== undefined) {
      countWithoutMeaning(this.#recallCounts, asked.withoutMeaning);
    }
    return recall(
      this.ctx.storage.sql,
      asked,
      countingInto(this.#recallCounts)
    );
  }

  /** A version, current or history, whole: if the reader may read it. */
  async readVersion(request: VersionRequest): Promise<SourceVersion | null> {
    await this.#ready();
    return await readVersion(
      this.#sources,
      checked(versionRequestSchema, request)
    );
  }

  /** The current versions of sources, whole: those the reader may read. */
  async readCurrent(request: CurrentRequest): Promise<SourceVersion[]> {
    await this.#ready();
    return await readCurrent(
      this.#sources,
      checked(currentRequestSchema, request)
    );
  }

  /** A page of the sources the reader may read, newest first. */
  async listSources(request: SourceListRequest): Promise<SourceList> {
    await this.#ready();
    return listSources(
      this.ctx.storage.sql,
      checked(sourceListRequestSchema, request)
    );
  }

  /** A page of the versions of a source the reader may read, newest first. */
  async listVersions(request: VersionListRequest): Promise<VersionList> {
    await this.#ready();
    return listVersions(
      this.ctx.storage.sql,
      checked(versionListRequestSchema, request)
    );
  }

  /** Of some versions, those the reader may read now: no text read. */
  async readableVersions(
    request: ReadableRequest
  ): Promise<SourceVersionRef[]> {
    await this.#ready();
    return readableVersions(
      this.#sources,
      checked(readableRequestSchema, request)
    );
  }

  /**
   * Erases a source for good (erasure.ts): recorded in the ledger and
   * hidden before it returns, deleted by its tick if not at once. Work
   * under way on it is stopped (work.ts `stopWorkOn`).
   */
  async eraseSource(request: SourceErasure): Promise<void> {
    await this.#ready();
    const { source, reason } = checked(sourceErasureSchema, request);
    await erase(this.#erasures, "source", source, reason, (sources) => {
      stopWorkOn(this.#work, sources);
    });
  }

  /**
   * Erases what only one person may read (erasure.ts), as `eraseSource`
   * erases a source.
   */
  async erasePerson(request: PersonErasure): Promise<void> {
    await this.#ready();
    const { person, reason } = checked(personErasureSchema, request);
    await erase(this.#erasures, "person", person, reason, (sources) => {
      stopWorkOn(this.#work, sources);
    });
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
    await this.#ready();
    const tickAt = checked(tickAtSchema, at);
    const model = checked(embedModelSchema.nullable(), embedders.model);
    if (this.#work.restarting) {
      // The store restarts in a moment: the next instance's tick works.
      return;
    }
    await this.#confirm(tickAt);
    this.#erase(tickAt);
    await this.#sweep(tickAt);
    this.#repack(tickAt);
    this.#reindex(tickAt);
    this.#embedding(tickAt, model);
    await workTick(
      this.ctx.storage,
      this.#work,
      {
        ask,
        embedders: {
          model,
          embed: async (request) => await embedders.embed(request),
        },
        bucket: this.env.BRAIN_OBJECTS,
      },
      tickAt
    );
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
    if ((await this.#ledgerStep()) !== "through") {
      return "unavailable";
    }
    return reembed(this.ctx.storage) ? "done" : "nothing";
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
        return await sweepFiles(
          this.ctx.storage,
          this.#db,
          this.env.BRAIN_OBJECTS,
          at
        );
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

  /** The queue, as staff see it. */
  workOverview(): WorkOverview {
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
    if ((await this.#ledgerStep()) !== "through") {
      return "unavailable";
    }
    return requeueWork(this.ctx.storage, item) ? "done" : "nothing";
  }

  /**
   * Starts a rebuild of the word indexes: `nothing` when one is under way;
   * `unavailable`, changing nothing, until the ledger is read through.
   */
  async rebuildWords(): Promise<StaffActionOutcome> {
    if ((await this.#ledgerStep()) !== "through") {
      return "unavailable";
    }
    return startWordsRebuild(this.ctx.storage.sql) ? "done" : "nothing";
  }

  /** Keeps vectors of current chunks as their codes, in one transaction. */
  async putVectors(request: VectorsToPut): Promise<void> {
    await this.#ready();
    const vectors = checked(vectorsToPutSchema, request);
    this.ctx.storage.transactionSync(() => {
      putVectors(this.ctx.storage.sql, vectors);
    });
  }

  /** What the reader may read of current chunks, nearest the vector first. */
  async searchVectors(request: VectorSearch): Promise<VectorsFound> {
    await this.#ready();
    return searchVectors(
      this.ctx.storage.sql,
      checked(vectorSearchSchema, request)
    );
  }

  /** Repacks one block holding removed codes: true when more are left. */
  async repackVectors(): Promise<boolean> {
    await this.#ready();
    return this.#repackOne();
  }

  /** One block repacked, in its own transaction: true when more are left. */
  #repackOne(): boolean {
    return this.ctx.storage.transactionSync(() =>
      repackVectors(this.ctx.storage.sql)
    );
  }
}
