/**
 * The embedder: a Durable Object that runs an embedding model, text in,
 * vector out. It knows nothing of what the text is or who may read it.
 *
 * On first use it copies the model's files from the model files bucket
 * into its own storage, checking each against its SHA-256: the tokenizer
 * and encoder in parts, the token table a row per token. It then reads the
 * whole table back once and records how many rows of which width it holds
 * (`model_record`). Then, and after every eviction, it reads the tokenizer
 * and encoder into a fresh instance of the module, checks the token table
 * against that record through its primary key alone (its last ID, and the
 * width of its first and last rows: well under a millisecond, where
 * reading all 256,000 rows of the real model took 68 to 85 ms on
 * Cloudflare), and embeds one short text, so the module's hot functions
 * are compiled before the first real text. A file that is missing, the
 * wrong size or the wrong hash fails the load: nothing is recorded, no
 * vector comes back, and the next call tries again.
 *
 * Each text reads only its own tokens' rows, and every row it reads must
 * be there at the recorded width. A table that fails either check (a row
 * missing or of the wrong width anywhere, or a table that disagrees with
 * its record) is damaged storage: the object forgets its copy and refuses,
 * and the next call copies the model from the bucket again. So no vector
 * is ever made from a damaged table, though a row in the middle is only
 * checked once a text needs it.
 *
 * A call embeds up to `maxTextsPerCall` texts (`embedMany`), one after
 * another, and answers each on its own: a text that fails costs its
 * neighbours nothing. Each object loads and embeds alone, so callers pick
 * an object by name: questions go to their own (`questionEmbedder`), so a
 * question never waits behind bulk work or another object's first load.
 */
import { DurableObject } from "cloudflare:workers";

import wasm from "./embed.wasm";
import { Engine, TextTooLongError, rowBytes } from "./engine.ts";
import type { FileBytes, Kernel, RowFormat } from "./engine.ts";
import { HashingReader } from "./hashing-reader.ts";
import {
  ModelFilesError,
  modelFileKey,
  modelIdentity,
  readTokensHeader,
  shippedModel,
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

/**
 * Why a text of a call has no vector, and nothing of the text itself:
 * - `too-long`: past the module's 256 KiB text buffer, where cutting it
 *   could change its tokens; the caller cuts it first;
 * - `not-text`: not a string;
 * - `kernel`: the module trapped on it; the object loads a fresh instance
 *   for the next text.
 */
export type EmbedFailure = "too-long" | "not-text" | "kernel";

/**
 * What a call answers for each of its texts: its embedding; why it has
 * none; or `deferred`, when the call's tokens (`maxTokensPerCall`) ran out
 * before it, so the caller sends it again in another call.
 */
export type EmbedResult =
  | ({ kind: "embedded" } & Embedding)
  | { kind: "failed"; reason: EmbedFailure }
  | { kind: "deferred" };

/**
 * The most texts one call takes; a call with more is refused whole. A call
 * costs a round trip of 10 to 36 ms on Cloudflare (0.04 ms locally),
 * against 1 to 3 ms of tokenising and reading rows per text: 16 texts a
 * call took the 4-layer model from 106 to 67 ms a 300-token passage, with
 * at most 2 ms of round trip left in each, so more would buy nothing.
 */
export const maxTextsPerCall = 16;

/**
 * The most tokens one call embeds: once a text would go past it, it and
 * every text after it are `deferred`, so a call ends within about 1.7 s of
 * CPU for the 4-layer model and 5 s for a 10-layer one of width 384 (0.21
 * and 0.61 ms a token on Cloudflare, against the 30 s a Durable Object
 * request may use). It is 16 texts of 512 tokens: with a model that reads
 * at most 512, a call of 16 always fits; with one that reads 1,024, 8 full
 * texts do. A first text always fits, as no model reads more than 1,024.
 * A caller that wants shorter calls sends fewer texts.
 */
export const maxTokensPerCall = 8192;

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

/** The token table as copied: its rows' format, how many rows, and each row's bytes. */
interface TableRecord {
  format: RowFormat;
  rows: number;
  rowBytes: number;
}

/** A model in memory, ready to embed. */
export interface Loaded {
  engine: Engine;
  table: TableRecord;
  identity: ModelIdentity;
}

const deferred: EmbedResult = { kind: "deferred" };

/** The model's files as the storage records them, to tell whether it holds this model. */
const filesOf = (model: EmbedModel): string =>
  [model.tokenizer.sha256, model.encoder.sha256, model.tokens.sha256].join(" ");

const isRowFormat = (value: string): value is RowFormat =>
  value === "float" || value === "int8";

const isText = (value: unknown): value is string => typeof value === "string";

/** Why `error` fails one text and not its call; undefined when it fails the call. */
const failureOf = (error: unknown): EmbedFailure | undefined => {
  if (error instanceof TextTooLongError) {
    return "too-long";
  }
  if (error instanceof WebAssembly.RuntimeError) {
    return "kernel";
  }
  return undefined;
};

export class Embedder extends DurableObject<EmbedderEnv> {
  /**
   * The model this object runs: none until a release names one
   * (`shippedModel`), and then it refuses every text.
   */
  protected readonly model: EmbedModel | null = shippedModel;
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
    // One row once every file is in and checked: the model's files, by
    // hash, and the token table as read back after the copy.
    sql.exec(`CREATE TABLE IF NOT EXISTS model_record (
      id INTEGER PRIMARY KEY CHECK (id = 1), files TEXT NOT NULL, format TEXT NOT NULL,
      rows INTEGER NOT NULL, row_bytes INTEGER NOT NULL)`);
    // The record before it kept the table's rows and width. Without it,
    // the model is copied again; an older release that finds it gone does
    // the same.
    sql.exec("DROP TABLE IF EXISTS loaded_model");
  }

  /** The model it runs; a `ModelFilesError` while it has none. */
  private get running(): EmbedModel {
    if (this.model === null) {
      throw new ModelFilesError(
        "No embedding model ships with this release, so nothing is embedded."
      );
    }
    return this.model;
  }

  /** The embedding of `text`, cut at the most tokens the model reads; throws when it can't be made. */
  async embed(text: string): Promise<Embedding> {
    const loaded = await this.loaded();
    const ids = this.inModule(() => loaded.engine.tokenize(text));
    return { vector: this.vectorOf(loaded, ids), model: loaded.identity };
  }

  /**
   * A result per text, in order (`EmbedResult`), each vector the same bits
   * as `embed` gives the text alone. At most `maxTextsPerCall` texts, and
   * `maxTokensPerCall` tokens: the texts after are `deferred`. Throws, and
   * answers nothing, when the model can't run at all (its files missing or
   * damaged): that is the embedder's failure, not a text's.
   */
  async embedMany(texts: readonly string[]): Promise<EmbedResult[]> {
    if (texts.length > maxTextsPerCall) {
      throw new RangeError(
        `An embedder call takes at most ${maxTextsPerCall} texts: send more as several calls.`
      );
    }
    const results: EmbedResult[] = [];
    let tokens = 0;
    for (const text of texts) {
      if (results.at(-1)?.kind === "deferred") {
        results.push(deferred);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one text at a time: after a trap, the next one loads a fresh instance
      const [result, used] = await this.embedOne(
        text,
        maxTokensPerCall - tokens
      );
      results.push(result);
      tokens += used;
    }
    return results;
  }

  /** One text of a call, within `budget` tokens, and the tokens it used. */
  private async embedOne(
    text: unknown,
    budget: number
  ): Promise<[EmbedResult, number]> {
    if (!isText(text)) {
      return [{ kind: "failed", reason: "not-text" }, 0];
    }
    const loaded = await this.loaded();
    try {
      const ids = this.inModule(() => loaded.engine.tokenize(text));
      if (ids.length > budget) {
        return [deferred, 0];
      }
      const vector = this.vectorOf(loaded, ids);
      return [{ kind: "embedded", vector, model: loaded.identity }, ids.length];
    } catch (error) {
      const reason = failureOf(error);
      if (reason === undefined) {
        throw error;
      }
      return [{ kind: "failed", reason }, 0];
    }
  }

  /** Runs `step` in the module. */
  private inModule<T>(step: () => T): T {
    try {
      return step();
    } catch (error) {
      // A trap leaves the module's state unknown: the next text loads a
      // fresh instance from storage instead of using this one.
      if (error instanceof WebAssembly.RuntimeError) {
        this.loading = undefined;
      }
      throw error;
    }
  }

  /** The embedding of the tokens `ids`. */
  private vectorOf(loaded: Loaded, ids: Int32Array): Float32Array {
    return this.inModule(() =>
      loaded.engine.embed(ids, loaded.table.format, (distinct) =>
        this.rows(distinct, loaded.table.rowBytes)
      )
    );
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
    const table = this.recorded() ?? (await this.copyFiles());
    this.checkTable(table);
    const engine = new Engine(
      wasm,
      { tokenizer: this.stored("tokenizer"), encoder: this.stored("encoder") },
      this.kernel
    );
    const width = rowBytes(table.format, engine.dim);
    if (table.rows !== engine.vocabSize || table.rowBytes !== width) {
      throw new ModelFilesError(
        `${this.running.name}'s token table doesn't fit its tokenizer and encoder: ${engine.vocabSize} rows of ${width} bytes wanted.`
      );
    }
    const loaded = {
      engine,
      table,
      identity: await modelIdentity(this.running),
    };
    this.vectorOf(loaded, engine.tokenize(warmUpText));
    return loaded;
  }

  /** The token table as recorded after its copy, when the storage holds this model's files. */
  private recorded(): TableRecord | null {
    const [stored] = this.ctx.storage.sql
      .exec<{
        files: string;
        format: string;
        rows: number;
        row_bytes: number;
      }>("SELECT files, format, rows, row_bytes FROM model_record")
      .toArray();
    if (
      stored?.files !== filesOf(this.running) ||
      !isRowFormat(stored.format)
    ) {
      return null;
    }
    return {
      format: stored.format,
      rows: stored.rows,
      rowBytes: stored.row_bytes,
    };
  }

  /**
   * Fails unless the token table is what `table` records, as far as its
   * primary key tells without reading every row: rows 0 to rows - 1, the
   * first and last of the recorded width.
   */
  private checkTable(table: TableRecord): void {
    const [found] = this.ctx.storage.sql
      .exec<{
        last: number | null;
        first_bytes: number | null;
        last_bytes: number | null;
      }>(
        `SELECT (SELECT MAX(id) FROM token_row) AS last,
          (SELECT LENGTH(row) FROM token_row WHERE id = 0) AS first_bytes,
          (SELECT LENGTH(row) FROM token_row ORDER BY id DESC LIMIT 1) AS last_bytes`
      )
      .toArray();
    if (
      found?.last !== table.rows - 1 ||
      found.first_bytes !== table.rowBytes ||
      found.last_bytes !== table.rowBytes
    ) {
      throw this.damaged();
    }
  }

  /**
   * Forgets the copy of the model, so the next call copies it again, and
   * returns the error that says so.
   */
  private damaged(): ModelFilesError {
    this.ctx.storage.sql.exec("DELETE FROM model_record");
    this.loading = undefined;
    return new ModelFilesError(
      `${this.running.name}'s token table in storage is damaged: the next call copies it from the model files bucket again.`
    );
  }

  /**
   * Copies the model's files from the bucket into storage, after clearing
   * whatever was there, checks the token table as stored, and records the
   * model once all of them are in. Returns the token table as recorded.
   */
  private async copyFiles(): Promise<TableRecord> {
    const { sql } = this.ctx.storage;
    const clear = (): void => {
      this.ctx.storage.transactionSync(() => {
        sql.exec("DELETE FROM model_record");
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
      const table = await this.copyTokens();
      this.checkCopiedTable(table);
      sql.exec(
        "INSERT INTO model_record (id, files, format, rows, row_bytes) VALUES (1, ?, ?, ?, ?)",
        filesOf(this.running),
        table.format,
        table.rows,
        table.rowBytes
      );
      return table;
    } catch (error) {
      clear();
      throw error;
    }
  }

  /**
   * Fails unless storage holds `table`'s rows, every one at its width: the
   * one time every row is read, so a wake can trust the record.
   */
  private checkCopiedTable(table: TableRecord): void {
    const [found] = this.ctx.storage.sql
      .exec<{ rows: number; least: number | null; most: number | null }>(
        "SELECT COUNT(*) AS rows, MIN(LENGTH(row)) AS least, MAX(LENGTH(row)) AS most FROM token_row"
      )
      .toArray();
    if (
      found?.rows !== table.rows ||
      found.least !== table.rowBytes ||
      found.most !== table.rowBytes
    ) {
      throw new ModelFilesError(
        `${this.running.name}'s token table in storage isn't the ${table.rows} rows of ${table.rowBytes} bytes copied into it.`
      );
    }
  }

  /** The file's bytes from the bucket, read in order and hashed as they come. */
  private async open(which: Which): Promise<HashingReader> {
    const file = this.running[which];
    const object = await this.env.MODEL_FILES.get(modelFileKey(file));
    if (object === null) {
      throw new ModelFilesError(
        `${this.running.name}'s ${which} file is missing: no ${modelFileKey(file)} in the model files bucket.`
      );
    }
    if (object.size !== file.size) {
      await object.body.cancel();
      throw new ModelFilesError(
        `${this.running.name}'s ${which} file is ${object.size} bytes, not ${file.size}.`
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
        `${this.running.name}'s ${which} file has SHA-256 ${sha256} (${reader.total} bytes), not ${file.sha256}.`
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
      await this.check(which, this.running[which], reader);
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

  private async copyTokens(): Promise<TableRecord> {
    return await this.copyFile("tokens", this.copyRows);
  }

  /** Reads the token table into storage, a row per token (an arrow, as `copyFile` calls it unbound). */
  private readonly copyRows = async (
    reader: HashingReader
  ): Promise<TableRecord> => {
    const header = readTokensHeader(
      (await reader.read(tokensHeaderBytes)) ?? new Uint8Array()
    );
    if (header === null) {
      throw new ModelFilesError(
        `${this.running.name}'s tokens file isn't a token table of this version.`
      );
    }
    const size = rowBytes(header.format, header.dim);
    const wrongRows = (): ModelFilesError =>
      new ModelFilesError(
        `${this.running.name}'s tokens file doesn't hold the ${header.rows} rows its header names.`
      );
    const { sql } = this.ctx.storage;
    let rows = 0;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const block = await reader.read(size * rowsPerBatch);
      if (block === null) {
        break;
      }
      const first = rows;
      const count = block.byteLength / size;
      if (!Number.isInteger(count) || first + count > header.rows) {
        throw wrongRows();
      }
      this.ctx.storage.transactionSync(() => {
        for (let i = 0; i < count; i += 1) {
          sql.exec(
            "INSERT INTO token_row (id, row) VALUES (?, ?)",
            first + i,
            block.subarray(i * size, (i + 1) * size)
          );
        }
      });
      rows += count;
    }
    if (rows !== header.rows) {
      throw wrongRows();
    }
    return { format: header.format, rows, rowBytes: size };
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

  /**
   * The token table's rows for `ids` (distinct), each `width` bytes: a row
   * missing or of another width is damaged storage.
   */
  private rows(ids: number[], width: number): Map<number, Uint8Array> {
    const found = this.ctx.storage.sql.exec<{ id: number; row: ArrayBuffer }>(
      "SELECT id, row FROM token_row WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify(ids)
    );
    const rows = new Map(
      Array.from(found, ({ id, row }) => [id, new Uint8Array(row)])
    );
    if (
      rows.size !== ids.length ||
      [...rows.values()].some((row) => row.byteLength !== width)
    ) {
      throw this.damaged();
    }
    return rows;
  }
}

/** The embedder that embeds questions, by itself so that a question never waits behind bulk work. */
export const questionEmbedder = (
  namespace: DurableObjectNamespace<Embedder>
): DurableObjectStub<Embedder> => namespace.getByName("questions");
