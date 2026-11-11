import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import {
  currentRequestSchema,
  newInstructionsSchema,
  newSourceSchema,
  recallRequestSchema,
  vectorSearchSchema,
  vectorsToPutSchema,
  versionRequestSchema,
} from "./contract.ts";
import type {
  AskModel,
  CurrentRequest,
  NewInstructions,
  NewSource,
  RecallRequest,
  Recalled,
  SourceVersion,
  SourceVersionRef,
  VectorSearch,
  VectorsFound,
  VectorsToPut,
  VersionRequest,
  WorkOverview,
} from "./contract.ts";
import migrations from "./db/migrations/migrations.js";
import { sweepFiles } from "./files.ts";
import { recall } from "./recall.ts";
import { addVersion, readCurrent, readVersion } from "./sources.ts";
import type { SourcesStore } from "./sources.ts";
import { putVectors, repackVectors, searchVectors } from "./vectors.ts";
import {
  newWorkState,
  releaseInterrupted,
  repackPerTick,
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

/** A tick's time: a valid date. */
const tickAtSchema = z.date();

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
    sweep: null,
    repack: null,
  };
  #sweepAfter = 0;

  /** This instance's state of its work queue: gone with it. */
  readonly #work = newWorkState(() => {
    this.ctx.abort("Handlers past their time held up the queue");
  });

  constructor(ctx: DurableObjectState, env: BrainStoreEnv) {
    super(ctx, env);
    // The schema is current, and what an earlier instance had under way
    // put back in the queue, before the object handles anything.
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.#db, migrations);
      releaseInterrupted(ctx.storage);
    });
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
    return await addVersion(this.#sources, checked(newSourceSchema, source), {
      indexed: true,
    });
  }

  /**
   * Adds a version of an instruction file, as `addSource` does, kept
   * whole: no chunks, no words, so recall never finds it.
   */
  async addInstructions(source: NewInstructions): Promise<SourceVersionRef> {
    return await addVersion(
      this.#sources,
      checked(newInstructionsSchema, source),
      { indexed: false }
    );
  }

  /** What the reader may read of current versions holding the question's words. */
  recall(request: RecallRequest): Recalled {
    const { question, reader } = checked(recallRequestSchema, request);
    return recall(this.ctx.storage.sql, question, reader);
  }

  /** A version, current or history, whole: if the reader may read it. */
  async readVersion(request: VersionRequest): Promise<SourceVersion | null> {
    return await readVersion(
      this.#sources,
      checked(versionRequestSchema, request)
    );
  }

  /** The current versions of sources, whole: those the reader may read. */
  async readCurrent(request: CurrentRequest): Promise<SourceVersion[]> {
    return await readCurrent(
      this.#sources,
      checked(currentRequestSchema, request)
    );
  }

  /**
   * One tick of the host's clock at `at`: one batch of the sweep, then up
   * to `repackPerTick` blocks of vector codes repacked, then the queue,
   * asking `ask` for its model calls (work.ts). Each step is bounded, so
   * none starves the next, and the queue runs whatever the others did.
   */
  async work(ask: AskModel, at: Date): Promise<void> {
    const tickAt = checked(tickAtSchema, at);
    await this.#sweep(tickAt);
    this.#repack(tickAt);
    await workTick(this.ctx.storage, this.#work, ask, tickAt);
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
        if (!this.repackVectors()) {
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
        return await sweepFiles(this.#db, this.env.BRAIN_OBJECTS, at);
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
      stepsFailed: { ...this.#stepsFailed },
    };
  }

  /** Keeps vectors of current chunks as their codes, in one transaction. */
  putVectors(request: VectorsToPut): void {
    const vectors = checked(vectorsToPutSchema, request);
    this.ctx.storage.transactionSync(() => {
      putVectors(this.ctx.storage.sql, vectors);
    });
  }

  /** What the reader may read of current chunks, nearest the vector first. */
  searchVectors(request: VectorSearch): VectorsFound {
    return searchVectors(
      this.ctx.storage.sql,
      checked(vectorSearchSchema, request)
    );
  }

  /** Repacks one block holding removed codes: true when more are left. */
  repackVectors(): boolean {
    return this.ctx.storage.transactionSync(() =>
      repackVectors(this.ctx.storage.sql)
    );
  }
}
