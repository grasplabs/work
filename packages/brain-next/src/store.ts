import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import {
  newSourceSchema,
  recallRequestSchema,
  sweepRequestSchema,
  vectorSearchSchema,
  vectorsToPutSchema,
  versionRequestSchema,
} from "./contract.ts";
import type {
  NewSource,
  RecallRequest,
  Recalled,
  SourceVersion,
  SourceVersionRef,
  SweepRequest,
  VectorSearch,
  VectorsFound,
  VectorsToPut,
  VersionRequest,
} from "./contract.ts";
import migrations from "./db/migrations/migrations.js";
import { sweepFiles } from "./files.ts";
import { recall } from "./recall.ts";
import { addVersion, readVersion } from "./sources.ts";
import type { SourcesStore } from "./sources.ts";
import { putVectors, repackVectors, searchVectors } from "./vectors.ts";

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

  constructor(ctx: DurableObjectState, env: BrainStoreEnv) {
    super(ctx, env);
    // The schema is current before the object handles anything.
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.#db, migrations);
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
    return await addVersion(this.#sources, checked(newSourceSchema, source));
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

  /**
   * Sweeps the files nothing points at (files.ts), while the store takes
   * nothing else, so no add notes a file the sweep is deleting.
   */
  async sweep(request: SweepRequest): Promise<void> {
    const { at } = checked(sweepRequestSchema, request);
    await this.ctx.blockConcurrencyWhile(async () => {
      await sweepFiles(this.#db, this.env.BRAIN_OBJECTS, at);
    });
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
