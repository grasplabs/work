/**
 * The host side of embed.wasm (rust/): one instance of the module with one
 * model in its memory. It knows nothing of where the model's files are
 * kept: the encoder and tokenizer come in as bytes, and the token table's
 * rows through a lookup the caller supplies, so the same engine runs in
 * the Durable Object and in Node (the full-model check). No platform APIs.
 */
import { z } from "zod";

/** How the token table's rows are stored: float32, or int8 behind a float32 scale. */
export type RowFormat = "float" | "int8";

/** Which integer kernels run (rust/src/lib.rs `set_kernel`): every choice gives the same bits. */
export type Kernel = "auto" | "dot" | "pairs";

const kernelCodes: Record<Kernel, number> = { auto: 0, dot: 1, pairs: 2 };
const rowFormatCodes: Record<RowFormat, number> = { float: 0, int8: 1 };

const call = z.custom<(...args: number[]) => number>(
  (value) => typeof value === "function"
);

/** The module's exports (rust/src/lib.rs). */
const exportsSchema = z.object({
  memory: z.instanceof(WebAssembly.Memory),
  alloc: call,
  model_init: call,
  tok_init: call,
  dim: call,
  max_tokens: call,
  vocab_size: call,
  longest_token: call,
  set_kernel: call,
  text_buf: call,
  text_cap: call,
  tokenize: call,
  ids_buf: call,
  rows_buf: call,
  forward: call,
});
type Exports = z.infer<typeof exportsSchema>;

/** A file's bytes, whole or in parts, and its size in all. */
export interface FileBytes {
  size: number;
  parts: Iterable<Uint8Array>;
}

/** Why the module refused a model file (rust/src/lib.rs `model_init`). */
const encoderErrors: Record<number, string> = {
  [-1]: "isn't an encoder file of this version",
  [-2]: "has a shape this runtime doesn't run",
  [-3]: "has sizes that don't add up",
};

/**
 * Runs `load`, a step that allocates in the module: the module traps when
 * its memory can't grow to what it allocates, and that becomes a load
 * error.
 */
const fitting = (load: () => number): number => {
  try {
    return load();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      throw new RangeError(
        "The model's files and buffers don't fit the module's memory.",
        { cause: error }
      );
    }
    throw error;
  }
};

/** Whitespace as the tokenizer's lstrip reads it (Rust's `char::is_whitespace`: Unicode White_Space). */
const whitespace = /\p{White_Space}/gu;

/** The bytes one row of the token table takes in `format`. */
export const rowBytes = (format: RowFormat, dim: number): number =>
  format === "float" ? 4 * dim : 4 + dim;

export class Engine {
  readonly dim: number;
  readonly maxTokens: number;
  readonly vocabSize: number;
  /** How many times one whitespace character may repeat before a run is shortened (`tokenize`). */
  private readonly runLimit: number;
  /** A run of one whitespace character, repeated more than `runLimit` times. */
  private readonly longRuns: RegExp;
  private readonly exports: Exports;
  private readonly encoder = new TextEncoder();

  /**
   * Instantiates the module and reads the encoder and tokenizer into it.
   * Throws when either is refused: the instance is then dropped, never
   * used half-loaded.
   */
  constructor(
    module: WebAssembly.Module,
    files: { encoder: FileBytes; tokenizer: FileBytes },
    kernel: Kernel = "auto"
  ) {
    // The module imports nothing.
    const instance = new WebAssembly.Instance(module, {});
    this.exports = exportsSchema.parse(instance.exports);
    const encoderStatus = fitting(() =>
      this.exports.model_init(this.copyIn(files.encoder), files.encoder.size)
    );
    if (encoderStatus !== 0) {
      throw new Error(
        `The encoder file ${encoderErrors[encoderStatus] ?? `was refused (${encoderStatus})`}.`
      );
    }
    const tokenizerStatus = fitting(() =>
      this.exports.tok_init(this.copyIn(files.tokenizer), files.tokenizer.size)
    );
    if (tokenizerStatus !== 0) {
      throw new Error(
        "The tokenizer file isn't a consistent tokenizer file of this version."
      );
    }
    this.exports.set_kernel(kernelCodes[kernel]);
    this.dim = this.exports.dim();
    this.maxTokens = this.exports.max_tokens();
    this.vocabSize = this.exports.vocab_size();
    this.runLimit = this.maxTokens * this.exports.longest_token() + 1;
    this.longRuns = new RegExp(
      String.raw`(\p{White_Space})\1{${String(this.runLimit)},}`,
      "gu"
    );
  }

  /** How much memory the module holds now. */
  get memoryBytes(): number {
    return this.exports.memory.buffer.byteLength;
  }

  /** The bytes of the module's memory, as they are now (it may grow). */
  private bytes(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer);
  }

  private copyIn(file: FileBytes): number {
    const base = this.exports.alloc(file.size);
    let offset = 0;
    for (const part of file.parts) {
      if (offset + part.byteLength > file.size) {
        throw new Error("A model file is longer than its size.");
      }
      this.bytes().set(part, base + offset);
      offset += part.byteLength;
    }
    if (offset !== file.size) {
      throw new Error("A model file is shorter than its size.");
    }
    return base;
  }

  /**
   * The text's token IDs, `<bos>` and `<eos>` included, cut at the most
   * tokens the model reads, as the reference tokenizer gives them for every
   * text it tokenizes within that limit. Two steps keep a text of any size
   * within the module's 256 KiB text buffer without changing that:
   *
   * - A run of one whitespace character repeated more than `runLimit`
   *   times keeps `runLimit` of them. In a text within the limit such a
   *   run can only be whitespace an added token with lstrip takes, past a
   *   head of at most max tokens x the longest token's bytes (each token
   *   covers at most that much), so the same tokens come out. In a text
   *   beyond the limit, the run alone still fills it.
   * - A text still longer than the buffer is cut there only when what is
   *   kept holds at least max tokens x the longest token's bytes of
   *   non-whitespace, which no lstrip can take: the text is then certainly
   *   beyond the limit, where the tokens kept near the cut may differ from
   *   the reference's (as for a long word, rust/src/tokenizer.rs).
   *   Otherwise it is refused: cut it before embedding.
   */
  tokenize(text: string): Int32Array {
    const bounded = text.replace(this.longRuns, (_run, char: string) =>
      char.repeat(this.runLimit)
    );
    // The buffer first: allocating it may grow the memory.
    const at = this.exports.text_buf();
    const { read, written } = this.encoder.encodeInto(
      bounded,
      this.bytes().subarray(at, at + this.exports.text_cap())
    );
    if (
      read < bounded.length &&
      this.encoder.encode(bounded.slice(0, read).replaceAll(whitespace, ""))
        .byteLength <
        this.runLimit - 1
    ) {
      throw new RangeError(
        "The text is too long to tokenize exactly: its first 256 KiB are mostly whitespace. Cut it before embedding."
      );
    }
    const count = this.exports.tokenize(written);
    return new Int32Array(
      this.exports.memory.buffer,
      this.exports.ids_buf(),
      count
    ).slice();
  }

  /**
   * The embedding of the tokens `ids` (from `tokenize`): `rows` returns
   * each distinct token's row of the token table, in `format`.
   */
  embed(
    ids: Int32Array,
    format: RowFormat,
    rows: (distinct: number[]) => Map<number, Uint8Array>
  ): Float32Array {
    const distinct = [...new Set(ids)];
    const found = rows(distinct);
    const size = rowBytes(format, this.dim);
    const base = this.exports.rows_buf();
    const memory = this.bytes();
    for (const [i, id] of ids.entries()) {
      const row = found.get(id);
      if (row?.byteLength !== size) {
        throw new Error(`The token table has no row for token ${id}.`);
      }
      memory.set(row, base + i * size);
    }
    const out = this.exports.forward(ids.length, rowFormatCodes[format]);
    if (out === 0) {
      throw new Error(`The encoder can't run on ${ids.length} tokens.`);
    }
    return new Float32Array(this.exports.memory.buffer, out, this.dim).slice();
  }
}
