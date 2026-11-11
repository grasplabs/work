/**
 * The embedder: a Durable Object that runs an embedding model, text in,
 * vector out. It knows nothing of what the text is or who may read it.
 *
 * On first use it copies the model's files from the model files bucket
 * into its own storage, checking each against its SHA-256: the tokenizer
 * and encoder in parts, the token table a row per token. Then, and after
 * every eviction, it reads the tokenizer and encoder into a fresh instance
 * of the module and embeds one short text, so the module's hot functions
 * are compiled before the first real text. Each text reads only its own
 * tokens' rows. A file that is missing, the wrong size or the wrong hash
 * fails the load: nothing is marked loaded, no vector comes back, and the
 * next call tries again.
 *
 * Each object loads and embeds alone, one text at a time, so callers pick
 * an object by name: questions go to their own (`questionEmbedder`), so a
 * question never waits behind bulk work or another object's first load.
 */
import { DurableObject } from "cloudflare:workers";

import wasm from "./embed.wasm";
import { Engine, rowBytes } from "./engine.ts";
import type { FileBytes, Kernel, RowFormat } from "./engine.ts";
import { HashingReader } from "./hashing-reader.ts";
import {
  ModelFilesError,
  bekkoA8m,
  modelFileKey,
  modelIdentity,
  readTokensHeader,
  tokensHeaderBytes,
} from "./model-files.ts";
import type { EmbedModel, ModelFile, ModelIdentity } from "./model-files.ts";

/** What the embedder needs from its Worker: the bucket that holds model files. */
export interface EmbedderEnv {
  MODEL_FILES: R2Bucket;
}

/** A text's embedding, and the model and build that made it. */
export interface Embedding {
  /** L2-normalised. */
  vector: Float32Array;
  model: ModelIdentity;
}

/** The short text embedded once after each load. */
const warmUpText =
  "Warm-up: a short sentence so every kernel runs once before the first text.";
/** How the tokenizer and encoder are stored: parts of 1 MiB (a SQLite value holds 2 MB at most). */
const partBytes = 2 ** 20;
/** How many token rows are written in one transaction: about 1.5 MiB of the real model's. */
const rowsPerBatch = 4096;

/** The two files the module reads whole, by the name the storage keeps them under. */
const wholeFiles = ["tokenizer", "encoder"] as const;
type WholeFile = (typeof wholeFiles)[number];
type Which = WholeFile | "tokens";

/** A model in memory, ready to embed. */
interface Loaded {
  engine: Engine;
  format: RowFormat;
  identity: ModelIdentity;
}

/** The model's files as the storage records them, to tell whether it holds this model. */
const filesOf = (model: EmbedModel): string =>
  [model.tokenizer.sha256, model.encoder.sha256, model.tokens.sha256].join(" ");

const isRowFormat = (value: string): value is RowFormat =>
  value === "float" || value === "int8";

export class Embedder extends DurableObject<EmbedderEnv> {
  /** The model this object runs. */
  protected readonly model: EmbedModel = bekkoA8m;
  /** Which integer kernels run: the fastest for this CPU, unless a test picks one. */
  protected readonly kernel: Kernel = "auto";
  private loading: Promise<Loaded> | undefined;

  constructor(ctx: DurableObjectState, env: EmbedderEnv) {
    super(ctx, env);
    const { sql } = ctx.storage;
    sql.exec(`CREATE TABLE IF NOT EXISTS model_part (
      file TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (file, part))`);
    sql.exec(
      "CREATE TABLE IF NOT EXISTS token_row (id INTEGER PRIMARY KEY, row BLOB NOT NULL)"
    );
    // One row once every file is in and checked: the model's files, by hash.
    sql.exec(`CREATE TABLE IF NOT EXISTS loaded_model (
      id INTEGER PRIMARY KEY CHECK (id = 1), files TEXT NOT NULL, format TEXT NOT NULL)`);
  }

  /** The embedding of `text`, cut at the most tokens the model reads. */
  async embed(text: string): Promise<Embedding> {
    const { engine, format, identity } = await this.loaded();
    try {
      const vector = engine.embed(engine.tokenize(text), format, (ids) =>
        this.rows(ids)
      );
      return { vector, model: identity };
    } catch (error) {
      // A trap leaves the module's state unknown: the next call loads a
      // fresh instance from storage instead of using this one.
      if (error instanceof WebAssembly.RuntimeError) {
        this.loading = undefined;
      }
      throw error;
    }
  }

  /** The model, loaded once per life of the object. */
  protected async loaded(): Promise<Loaded> {
    this.loading ??= this.loadOnce();
    return await this.loading;
  }

  /** Loads the model; a failed load is forgotten, so the next call tries again. */
  private async loadOnce(): Promise<Loaded> {
    try {
      return await this.load();
    } catch (error) {
      this.loading = undefined;
      throw error;
    }
  }

  private async load(): Promise<Loaded> {
    const [stored] = this.ctx.storage.sql
      .exec<{
        files: string;
        format: string;
      }>("SELECT files, format FROM loaded_model")
      .toArray();
    const format =
      stored?.files === filesOf(this.model) && isRowFormat(stored.format)
        ? stored.format
        : await this.copyFiles();
    const engine = new Engine(
      wasm,
      { tokenizer: this.stored("tokenizer"), encoder: this.stored("encoder") },
      this.kernel
    );
    const [table] = this.ctx.storage.sql
      .exec<{ rows: number; least: number | null; most: number | null }>(
        "SELECT COUNT(*) AS rows, MIN(LENGTH(row)) AS least, MAX(LENGTH(row)) AS most FROM token_row"
      )
      .toArray();
    const width = rowBytes(format, engine.dim);
    if (
      table?.rows !== engine.vocabSize ||
      table.least !== width ||
      table.most !== width
    ) {
      throw new ModelFilesError(
        `${this.model.name}'s token table doesn't fit its tokenizer and encoder: ${engine.vocabSize} rows of ${width} bytes wanted.`
      );
    }
    engine.embed(engine.tokenize(warmUpText), format, (ids) => this.rows(ids));
    return { engine, format, identity: await modelIdentity(this.model) };
  }

  /**
   * Copies the model's files from the bucket into storage, after clearing
   * whatever was there, and marks the model loaded once all of them are in
   * and checked. Returns the token table's row format.
   */
  private async copyFiles(): Promise<RowFormat> {
    const { sql } = this.ctx.storage;
    const clear = (): void => {
      this.ctx.storage.transactionSync(() => {
        sql.exec("DELETE FROM loaded_model");
        sql.exec("DELETE FROM model_part");
        sql.exec("DELETE FROM token_row");
      });
    };
    clear();
    try {
      for (const file of wholeFiles) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time, to keep memory low
        await this.copyWhole(file);
      }
      const format = await this.copyTokens();
      sql.exec(
        "INSERT INTO loaded_model (id, files, format) VALUES (1, ?, ?)",
        filesOf(this.model),
        format
      );
      return format;
    } catch (error) {
      clear();
      throw error;
    }
  }

  /** The file's bytes from the bucket, read in order and hashed as they come. */
  private async open(which: Which): Promise<HashingReader> {
    const file = this.model[which];
    const object = await this.env.MODEL_FILES.get(modelFileKey(file));
    if (object === null) {
      throw new ModelFilesError(
        `${this.model.name}'s ${which} file is missing: no ${modelFileKey(file)} in the model files bucket.`
      );
    }
    if (object.size !== file.size) {
      await object.body.cancel();
      throw new ModelFilesError(
        `${this.model.name}'s ${which} file is ${object.size} bytes, not ${file.size}.`
      );
    }
    return new HashingReader(object.body);
  }

  /** Fails unless what `reader` read is `file`, byte for byte. */
  private async check(
    which: Which,
    file: ModelFile,
    reader: HashingReader
  ): Promise<void> {
    const sha256 = await reader.sha256();
    if (reader.total !== file.size || sha256 !== file.sha256) {
      throw new ModelFilesError(
        `${this.model.name}'s ${which} file has SHA-256 ${sha256} (${reader.total} bytes), not ${file.sha256}.`
      );
    }
  }

  /**
   * Opens the file, lets `copy` read it to its end, and checks it. On any
   * failure the bucket's stream is cancelled before the error goes on.
   */
  private async copyFile<T>(
    which: Which,
    copy: (reader: HashingReader) => Promise<T>
  ): Promise<T> {
    const reader = await this.open(which);
    try {
      const result = await copy(reader);
      await this.check(which, this.model[which], reader);
      return result;
    } catch (error) {
      await reader.cancel();
      throw error;
    }
  }

  private async copyWhole(which: WholeFile): Promise<void> {
    await this.copyFile(which, async (reader) => {
      for (let part = 0; ; part += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
        const bytes = await reader.read(partBytes);
        if (bytes === null) {
          break;
        }
        this.ctx.storage.sql.exec(
          "INSERT INTO model_part (file, part, bytes) VALUES (?, ?, ?)",
          which,
          part,
          bytes
        );
      }
    });
  }

  private async copyTokens(): Promise<RowFormat> {
    return await this.copyFile("tokens", this.copyRows);
  }

  /** Reads the token table into storage, a row per token (an arrow, as `copyFile` calls it unbound). */
  private readonly copyRows = async (
    reader: HashingReader
  ): Promise<RowFormat> => {
    const header = readTokensHeader(
      (await reader.read(tokensHeaderBytes)) ?? new Uint8Array()
    );
    if (header === null) {
      throw new ModelFilesError(
        `${this.model.name}'s tokens file isn't a token table of this version.`
      );
    }
    const size = rowBytes(header.format, header.dim);
    const { sql } = this.ctx.storage;
    for (let id = 0; ;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const block = await reader.read(size * rowsPerBatch);
      if (block === null) {
        break;
      }
      if (
        block.byteLength % size !== 0 ||
        id + block.byteLength / size > header.rows
      ) {
        throw new ModelFilesError(
          `${this.model.name}'s tokens file doesn't hold the ${header.rows} rows its header names.`
        );
      }
      this.ctx.storage.transactionSync(() => {
        for (let at = 0; at < block.byteLength; at += size) {
          sql.exec(
            "INSERT INTO token_row (id, row) VALUES (?, ?)",
            id,
            block.subarray(at, at + size)
          );
          id += 1;
        }
      });
    }
    return header.format;
  };

  /** A stored file's parts, for the module to read. */
  private stored(file: WholeFile): FileBytes {
    const parts = this.ctx.storage.sql
      .exec<{
        bytes: ArrayBuffer;
      }>("SELECT bytes FROM model_part WHERE file = ? ORDER BY part", file)
      .toArray()
      .map(({ bytes }) => new Uint8Array(bytes));
    return {
      size: parts.reduce((sum, part) => sum + part.byteLength, 0),
      parts,
    };
  }

  /** The token table's rows for `ids`. */
  private rows(ids: number[]): Map<number, Uint8Array> {
    const found = this.ctx.storage.sql.exec<{ id: number; row: ArrayBuffer }>(
      "SELECT id, row FROM token_row WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify(ids)
    );
    return new Map(
      Array.from(found, ({ id, row }) => [id, new Uint8Array(row)])
    );
  }
}

/** The embedder that embeds questions, by itself so that a question never waits behind bulk work. */
export const questionEmbedder = (
  namespace: DurableObjectNamespace<Embedder>
): DurableObjectStub<Embedder> => namespace.getByName("questions");
