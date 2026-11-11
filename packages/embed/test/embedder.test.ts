// The embedder through its Durable Object, on the tiny models in fixtures/
// (scripts/make-fixture.py): its vectors and token IDs against Hugging
// Face's, the same bits from every integer kernel, a model of another depth
// and shape run from its file alone, its model files checked before use,
// and a reload after an eviction.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { Embedder, questionEmbedder } from "../src/embedder.ts";
import type { Kernel } from "../src/engine.ts";
import { modelFileKey } from "../src/model-files.ts";
import type { EmbedModel } from "../src/model-files.ts";
import deepEncoderFloat from "./fixtures/deep/encoder-float.bin";
import deepEncoderInt8 from "./fixtures/deep/encoder-int8.bin";
import deepInt8Bits from "./fixtures/deep/int8-bits.json";
import deepReference from "./fixtures/deep/reference.json";
import deepTokensFloat from "./fixtures/deep/tokens-float.bin";
import deepTokensInt8 from "./fixtures/deep/tokens-int8.bin";
import encoderFloat from "./fixtures/encoder-float.bin";
import encoderInt8 from "./fixtures/encoder-int8.bin";
import int8Bits from "./fixtures/int8-bits.json";
import reference from "./fixtures/reference.json";
import tokenizer from "./fixtures/tokenizer.bin";
import tokensFloat from "./fixtures/tokens-float.bin";
import tokensInt8 from "./fixtures/tokens-int8.bin";
import {
  deepFloatModel,
  deepInt8Model,
  floatModel,
  int8Model,
} from "./worker.ts";
import type { CustomEmbedder, Int8Embedder } from "./worker.ts";

/**
 * How close the embedder comes to the reference (Hugging Face transformers,
 * float32): the float path within float32 rounding, each component within
 * 1e-5 (measured 4e-7); the int8 path, which production runs, at cosine
 * 0.99 or more for every text (measured 0.9952 on this random, untrained
 * fixture, which 8 bits suit worse than a trained model; 0.9961 on the
 * real model, scripts/check-model.ts). The int8 path's exact bits are
 * pinned as well (int8-bits.json).
 */
const floatTolerance = 1e-5;
const int8LeastCosine = 0.99;

type Which = "tokenizer" | "encoder" | "tokens";
type Files = Record<Which, ArrayBuffer | Uint8Array>;
const int8Files: Files = {
  tokenizer,
  encoder: encoderInt8,
  tokens: tokensInt8,
};
const floatFiles: Files = {
  tokenizer,
  encoder: encoderFloat,
  tokens: tokensFloat,
};
const deepInt8Files: Files = {
  tokenizer,
  encoder: deepEncoderInt8,
  tokens: deepTokensInt8,
};
const deepFloatFiles: Files = {
  tokenizer,
  encoder: deepEncoderFloat,
  tokens: deepTokensFloat,
};
const everyFile: Which[] = ["tokenizer", "encoder", "tokens"];

/** Puts the model's files in the bucket, each where the model names it. */
const upload = async (
  model: EmbedModel,
  files: Files,
  only: Which[] = everyFile
): Promise<void> => {
  await Promise.all(
    only.map(
      async (which) =>
        await env.MODEL_FILES.put(modelFileKey(model[which]), files[which])
    )
  );
};

/**
 * What two embeds in a row in `embedder` end with: each error's message,
 * or "embedded". Two, as a failed load must leave nothing behind that a
 * second call could use. Run inside the object, as an error thrown back
 * across RPC reaches the test pool as unhandled.
 */
const twoEmbeds = async (
  embedder: DurableObjectStub<Int8Embedder> | DurableObjectStub<CustomEmbedder>
): Promise<string[]> =>
  await runInDurableObject(embedder, async (instance) => {
    if (!(instance instanceof Embedder)) {
      throw new TypeError("Not an embedder.");
    }
    const attempt = async (): Promise<string> => {
      try {
        await instance.embed("Hallo");
        return "embedded";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    return [await attempt(), await attempt()];
  });

/** Rounds up to a multiple of 16, as the encoder file aligns its parts. */
const pad16 = (n: number): number => Math.ceil(n / 16) * 16;
/** The bytes of one rotary table (cos or sin) for `maxTokens` tokens. */
const tableBytes = (maxTokens: number): number => maxTokens * 32 * 4;
/**
 * The encoder file's header words (rust/src/encoder.rs): the model's, then
 * four per layer (kind, heads, feed-forward width, float channels).
 */
const headerWord = {
  version: 1,
  hidden: 3,
  layers: 4,
  maxTokens: 5,
  tables: 7,
};
const modelWords = 8;
const layerWord = (layer: number, which: 0 | 1 | 2 | 3): number =>
  modelWords + 4 * layer + which;
const [kind, heads, feedForward, floatChannels] = [0, 1, 2, 3] as const;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * An embedder named `name` that runs a model made of `files`, each named
 * by its own hash and put in the bucket: for files that are wrong on
 * purpose but are what the model names.
 */
const customEmbedder = async (
  name: string,
  files: Record<Which, Uint8Array>,
  kernel: Kernel = "auto"
): Promise<DurableObjectStub<CustomEmbedder>> => {
  const named = async (bytes: Uint8Array) => ({
    sha256: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))),
    size: bytes.byteLength,
  });
  const model: EmbedModel = {
    name,
    tokenizer: await named(files.tokenizer),
    encoder: await named(files.encoder),
    tokens: await named(files.tokens),
  };
  await upload(model, files);
  const stub = env.CUSTOM.getByName(name);
  await stub.use(model, kernel);
  return stub;
};

/**
 * The int8 fixture's encoder with one group of 4 weights that feeds a
 * 16-bit lane of the pair kernel (layer 0's qkv, first panel, output 0,
 * k 0, 1, 4 and 5) set to 127 each: sum |w| = 508, past the 258 the pair
 * kernel needs (`pairable`), so its matrices can't run it exactly.
 */
const unpairableEncoder = (): Uint8Array => {
  const bytes = Uint8Array.from(new Uint8Array(encoderInt8));
  const view = new DataView(bytes.buffer);
  const word = (i: number): number => view.getUint32(i * 4, true);
  const [hidden, layers, maxTokens, tables] = [
    word(headerWord.hidden),
    word(headerWord.layers),
    word(headerWord.maxTokens),
    word(headerWord.tables),
  ];
  const qkv =
    pad16((modelWords + 4 * layers) * 4) +
    2 * pad16(hidden * 4) +
    2 * tables * tableBytes(maxTokens);
  // Panel layout [k/4][2 halves][4 outputs][4 ks]: k 0 and 1 in the first
  // 4 bytes' first two, k 4 and 5 one k4 step (32 bytes) on.
  for (const at of [0, 1, 32, 33]) {
    bytes[qkv + at] = 127;
  }
  return bytes;
};

/** The float fixture's encoder with header word `index` set to `value`. */
const withHeaderWord = (index: number, value: number): Uint8Array => {
  const bytes = Uint8Array.from(new Uint8Array(encoderFloat));
  new DataView(bytes.buffer).setUint32(index * 4, value, true);
  return bytes;
};

/**
 * A fixture encoder declaring `maxTokens` tokens, with rotary tables of
 * that size whose cosines are all `cos` and sines all zero: every position
 * then rotates alike, so equal tokens get equal queries and keys, scaled by
 * `cos` (zero by default: every score zero).
 */
const withMaxTokens = (
  encoder: ArrayBuffer,
  maxTokens: number,
  cos = 0
): Uint8Array => {
  const source = new Uint8Array(encoder);
  const view = new DataView(source.buffer);
  const word = (i: number): number => view.getUint32(i * 4, true);
  const [hidden, layers, oldMax, tables] = [
    word(headerWord.hidden),
    word(headerWord.layers),
    word(headerWord.maxTokens),
    word(headerWord.tables),
  ];
  const headerBytes = pad16((modelWords + 4 * layers) * 4);
  const normsEnd = headerBytes + 2 * pad16(hidden * 4);
  const layersStart = normsEnd + 2 * tables * tableBytes(oldMax);
  const out = new Uint8Array(
    normsEnd +
      2 * tables * tableBytes(maxTokens) +
      source.byteLength -
      layersStart
  );
  out.set(source.subarray(0, normsEnd));
  out.set(
    source.subarray(layersStart),
    normsEnd + 2 * tables * tableBytes(maxTokens)
  );
  new DataView(out.buffer).setUint32(headerWord.maxTokens * 4, maxTokens, true);
  // Each table is its cosines, then its sines.
  for (let table = 0; table < tables; table += 1) {
    const at = normsEnd + 2 * table * tableBytes(maxTokens);
    new Float32Array(out.buffer, at, tableBytes(maxTokens) / 4).fill(cos);
  }
  return out;
};

/** A token table file with the rows of tokens `copies` replaced by the row of token `from`. */
const withRowsOf = (
  table: ArrayBuffer,
  rowBytes: number,
  from: number,
  copies: number[]
): Uint8Array => {
  const out = Uint8Array.from(new Uint8Array(table));
  const row = out.slice(32 + from * rowBytes, 32 + (from + 1) * rowBytes);
  for (const id of copies) {
    out.set(row, 32 + id * rowBytes);
  }
  return out;
};

/**
 * A float encoder of zeros, one layer, width 64, one head, feed-forward
 * 16,384, 1,024 tokens: within every bound the parser sets, but its
 * buffers need over 136 MB, past the module's 64 MiB.
 */
const tooLargeEncoder = (): Uint8Array => {
  const [hidden, ff, maxTokens, window, tables] = [64, 16_384, 1024, 8, 1];
  const header = new Uint8Array(pad16((modelWords + 4) * 4));
  const words = new DataView(header.buffer);
  header.set(new TextEncoder().encode("GENC"));
  for (const [i, value] of [
    2,
    0,
    hidden,
    1,
    maxTokens,
    window,
    tables,
    // The layer: global, no attention norm, one head, no float channels.
    0,
    1,
    ff,
    0,
  ].entries()) {
    words.setUint32((i + 1) * 4, value, true);
  }
  const floats = (n: number): number => pad16(n * 4);
  const layer =
    floats(3 * 64 * hidden) +
    floats(hidden * 64) +
    floats(2 * ff * hidden) +
    floats(hidden * ff) +
    2 * floats(hidden);
  const out = new Uint8Array(
    header.byteLength +
      2 * floats(hidden) +
      2 * tables * tableBytes(maxTokens) +
      layer
  );
  out.set(header);
  return out;
};

/** A vector's float32 bits, as hex: what "the same bits" compares. */
const bitsOf = (vector: Float32Array): string =>
  hex(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
};

describe("embedder", () => {
  it("embeds as the reference model does, on the float path", async () => {
    await upload(floatModel, floatFiles);
    const embedder = env.FLOAT.getByName("float");
    for (const { text, vector } of reference.embeddings) {
      // oxlint-disable-next-line no-await-in-loop -- one object embeds one text at a time
      const embedding = await embedder.embed(text);
      expect(embedding.vector).toHaveLength(vector.length);
      const furthest = Math.max(
        ...Array.from(embedding.vector, (value, i) =>
          Math.abs(value - (vector[i] ?? 0))
        )
      );
      expect(furthest).toBeLessThanOrEqual(floatTolerance);
    }
  });

  it("embeds within the int8 tolerance of the reference, texts longer than the window and cut ones included", async () => {
    await upload(int8Model, int8Files);
    const embedder = env.INT8.getByName("int8");
    for (const { text, vector } of reference.embeddings) {
      // oxlint-disable-next-line no-await-in-loop -- one object embeds one text at a time
      const embedding = await embedder.embed(text);
      expect(dot(embedding.vector, vector)).toBeGreaterThanOrEqual(
        int8LeastCosine
      );
      expect(dot(embedding.vector, embedding.vector)).toBeCloseTo(1, 5);
    }
  });

  it("tokenizes as the reference tokenizer does", async () => {
    await upload(int8Model, int8Files);
    const embedder = env.INT8.getByName("tokens");
    const cases = [...reference.embeddings, ...reference.tokens];
    const ours = await Promise.all(
      cases.map(async ({ text }) => await embedder.tokenize(text))
    );
    expect(ours).toStrictEqual(cases.map(({ ids }) => ids));
  });

  it("gives the same bits whichever integer kernel runs", async () => {
    await upload(int8Model, int8Files);
    const objects = [
      env.INT8.getByName("auto"),
      env.DOT.getByName("dot"),
      env.PAIRS.getByName("pairs"),
    ];
    for (const { text } of reference.embeddings) {
      // oxlint-disable-next-line no-await-in-loop -- each object embeds one text at a time
      const [auto, ...forced] = await Promise.all(
        objects.map(async (embedder) => {
          const { vector } = await embedder.embed(text);
          return bitsOf(vector);
        })
      );
      expect(forced).toStrictEqual([auto, auto]);
    }
  });

  it("says which kernels run, mixed when a matrix can't run the pairs exactly, with the same bits", async () => {
    const files = {
      tokenizer: new Uint8Array(tokenizer),
      tokens: new Uint8Array(tokensInt8),
    };
    const [pairs, dotOnly, mixed, mixedDot] = await Promise.all([
      customEmbedder(
        "kernel-pairs",
        { ...files, encoder: new Uint8Array(encoderInt8) },
        "pairs"
      ),
      customEmbedder(
        "kernel-dot",
        { ...files, encoder: new Uint8Array(encoderInt8) },
        "dot"
      ),
      customEmbedder(
        "kernel-mixed",
        { ...files, encoder: unpairableEncoder() },
        "pairs"
      ),
      customEmbedder(
        "kernel-mixed-dot",
        { ...files, encoder: unpairableEncoder() },
        "dot"
      ),
    ]);
    await expect(
      Promise.all(
        [pairs, dotOnly, mixed, mixedDot].map(
          async (stub) => await stub.kernelInUse()
        )
      )
    ).resolves.toStrictEqual(["pairs", "dot", "mixed", "dot"]);
    const text = reference.embeddings.at(-1)?.text ?? "";
    const [a, b] = await Promise.all([mixed.embed(text), mixedDot.embed(text)]);
    expect(bitsOf(a.vector)).toBe(bitsOf(b.vector));
  });

  it("names the model and the build that made each vector", async () => {
    await Promise.all([
      upload(int8Model, int8Files),
      upload(floatModel, floatFiles),
    ]);
    const text = "Wie viele Urlaubstage habe ich noch?";
    const [int8, float] = await Promise.all([
      env.INT8.getByName("identity").embed(text),
      env.FLOAT.getByName("identity").embed(text),
    ]);
    expect(int8.model.name).toBe("fixture-int8");
    expect(float.model.name).toBe("fixture-float");
    expect(int8.model.build).toMatch(/^[0-9a-f]{16}$/u);
    expect(float.model.build).not.toBe(int8.model.build);
  });

  it("gives the exact bits recorded for the int8 path, on whichever CPU runs it", async () => {
    // fixtures/int8-bits.json was written once (scripts/fixture-bits.ts):
    // CI on x86 and a laptop on ARM both have to give these bits.
    await upload(int8Model, int8Files);
    const embedder = env.INT8.getByName("bits");
    const bits = await Promise.all(
      reference.embeddings.map(async ({ text }) => {
        const { vector } = await embedder.embed(text);
        return hex(
          new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
        );
      })
    );
    expect(bits).toStrictEqual(int8Bits);
  });

  it("runs a model of another depth, other local layers and pruned widths from its file alone, as its reference does", async () => {
    // fixtures/deep: 5 layers, the first local and without an attention
    // norm, one head in layer 2 and a feed-forward width of 32 in layer 3.
    const runs: [string, EmbedModel, Files, Kernel][] = [
      ["deep-float", deepFloatModel, deepFloatFiles, "auto"],
      ["deep-int8", deepInt8Model, deepInt8Files, "auto"],
      ["deep-dot", deepInt8Model, deepInt8Files, "dot"],
      ["deep-pairs", deepInt8Model, deepInt8Files, "pairs"],
    ];
    const stubs = await Promise.all(
      runs.map(async ([name, model, files, kernel]) => {
        await upload(model, files);
        const stub = env.CUSTOM.getByName(name);
        await stub.use(model, kernel);
        return stub;
      })
    );
    const bits: string[] = [];
    for (const { text, vector } of deepReference.embeddings) {
      // oxlint-disable-next-line no-await-in-loop -- each object embeds one text at a time
      const [float, ...int8] = await Promise.all(
        stubs.map(async (stub) => {
          const embedding = await stub.embed(text);
          return embedding.vector;
        })
      );
      const furthest = Math.max(
        ...Array.from(float ?? [], (value, i) =>
          Math.abs(value - (vector[i] ?? 0))
        )
      );
      expect(furthest).toBeLessThanOrEqual(floatTolerance);
      const [auto, ...forced] = int8.map((v) => bitsOf(v));
      expect(dot(int8[0] ?? [], vector)).toBeGreaterThanOrEqual(
        int8LeastCosine
      );
      expect(forced).toStrictEqual([auto, auto]);
      bits.push(auto ?? "");
    }
    expect(bits).toStrictEqual(deepInt8Bits);
  });

  it("keeps attention's integer sums in range at the most tokens a model may read, for small and huge scores", async () => {
    // 1,024 equal tokens (<bos> and <eos> given the same row) under rotary
    // tables that rotate every position alike: every score in a row is
    // equal, so each P is the most it can be and each value lane sums
    // 1,024 x 16,383 x 127 at a column's largest value, the most att_pv
    // can reach (rust/src/encoder.rs, MAX_TOKENS). Cosines of 0 make the
    // scores zero; cosines of 10,000 scale them by 10^8, past 2^25, where
    // float32 rounds max - 14 by several units (att_softmax). The float
    // path is the scalar reference.
    await upload(int8Model, int8Files);
    const text = "a ".repeat(2000);
    // The fixture reads 128 tokens: enough to learn which IDs the text has.
    const ids = await env.INT8.getByName("uniform-ids").tokenize(text);
    const [bos, a, eos] = [ids[0] ?? 0, ids[1] ?? 0, ids.at(-1) ?? 0];
    expect(new Set(ids.slice(1, -1))).toStrictEqual(new Set([a]));
    for (const cos of [0, 10_000]) {
      const model = (
        encoder: ArrayBuffer,
        tokens: ArrayBuffer,
        rowBytes: number
      ) => ({
        tokenizer: new Uint8Array(tokenizer),
        encoder: withMaxTokens(encoder, 1024, cos),
        tokens: withRowsOf(tokens, rowBytes, a, [bos, eos]),
      });
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const [int8, float] = await Promise.all([
        customEmbedder(
          `uniform-int8-${cos}`,
          model(encoderInt8, tokensInt8, 4 + 128)
        ),
        customEmbedder(
          `uniform-float-${cos}`,
          model(encoderFloat, tokensFloat, 4 * 128)
        ),
      ]);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(int8.tokenize(text)).resolves.toHaveLength(1024);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const [quantised, reference32] = await Promise.all([
        int8.embed(text),
        float.embed(text),
      ]);
      expect(
        dot(quantised.vector, reference32.vector),
        `cosines ${String(cos)}`
      ).toBeGreaterThanOrEqual(int8LeastCosine);
    }
  });

  it("refuses a text past the buffer when cutting it there could change its tokens", async () => {
    await upload(int8Model, int8Files);
    const stub = env.INT8.getByName("refused");
    // Whitespace an lstrip token could take (the reference gives <bos>
    // <mask> <eos> for the first), so what follows the cut could change
    // the tokens before it.
    const texts = [
      `${" ".repeat(262_144)}<mask>`,
      `${" \n".repeat(200_000)}<mask>`,
    ];
    const outcomes = await runInDurableObject(stub, async (instance) => {
      if (!(instance instanceof Embedder)) {
        throw new TypeError("Not an embedder.");
      }
      const attempt = async (text: string): Promise<string> => {
        try {
          await instance.embed(text);
          return "embedded";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      return [await attempt(texts[0] ?? ""), await attempt(texts[1] ?? "")];
    });
    const refused =
      "The text is longer than the embedder's 256 KiB text buffer, and cutting it there could change its tokens. Cut it before embedding.";
    expect(outcomes).toStrictEqual([refused, refused]);
  });

  it("answers questions from an object of their own, with the same model", async () => {
    await upload(int8Model, int8Files);
    const text = "Who approves purchase orders above 5,000 euros?";
    const [question, other] = await Promise.all([
      questionEmbedder(env.INT8).embed(text),
      env.INT8.getByName("other").embed(text),
    ]);
    expect(bitsOf(question.vector)).toBe(bitsOf(other.vector));
    expect(question.model).toStrictEqual(other.model);
  });

  it("reads a lone surrogate as the replacement character, as UTF-8 encoding does", async () => {
    await upload(int8Model, int8Files);
    const embedder = env.INT8.getByName("surrogate");
    const [lone, replaced] = await Promise.all([
      embedder.tokenize("a\uD800b \uDC00"),
      embedder.tokenize("a�b �"),
    ]);
    expect(lone).toStrictEqual(replaced);
    const [first, second] = await Promise.all([
      embedder.embed("a\uD800b"),
      embedder.embed("a\uD800b"),
    ]);
    expect(bitsOf(first.vector)).toBe(bitsOf(second.vector));
  });

  it("cuts a long text without spaces at the most tokens the model reads", async () => {
    await upload(int8Model, int8Files);
    const embedder = env.INT8.getByName("long");
    const [huge, long] = await Promise.all([
      embedder.tokenize("Rechnungsprüfung".repeat(16_000)),
      embedder.tokenize("Rechnungsprüfung".repeat(200)),
    ]);
    expect(huge).toHaveLength(128);
    expect(huge).toStrictEqual(long);
  });

  it("fails closed on a model whose buffers don't fit the module's memory", async () => {
    const embedder = await customEmbedder("too-large", {
      tokenizer: new Uint8Array(tokenizer),
      encoder: tooLargeEncoder(),
      tokens: new Uint8Array(tokensFloat),
    });
    const tooLarge =
      "The model's files and buffers don't fit the module's memory.";
    await expect(twoEmbeds(embedder)).resolves.toStrictEqual([
      tooLarge,
      tooLarge,
    ]);
  });

  it("fails closed on encoder files that are malformed but what the model names", async () => {
    const shape = "The encoder file has a shape this runtime doesn't run.";
    const sizes = "The encoder file has sizes that don't add up.";
    const cases: [string, Uint8Array, string][] = [
      ["truncated", new Uint8Array(encoderFloat.slice(0, 5000)), sizes],
      // Cut inside the per-layer header words.
      ["header-cut", new Uint8Array(encoderFloat.slice(0, 40)), sizes],
      ["width", withHeaderWord(headerWord.hidden, 120), shape],
      ["layers", withHeaderWord(headerWord.layers, 2 ** 30), shape],
      // A head count whose product with the head width wraps on 32 bits.
      ["heads", withHeaderWord(layerWord(1, heads), 2 ** 26 + 1), shape],
      ["no-heads", withHeaderWord(layerWord(0, heads), 0), shape],
      [
        "feed-forward",
        withHeaderWord(layerWord(0, feedForward), 0xff_ff_ff_f0),
        shape,
      ],
      [
        "feed-forward-step",
        withHeaderWord(layerWord(1, feedForward), 72),
        shape,
      ],
      // As many float channels as the feed-forward has, or a remainder the
      // integer kernels can't step through.
      [
        "float-channels",
        withHeaderWord(layerWord(1, floatChannels), 64),
        shape,
      ],
      ["float-step", withHeaderWord(layerWord(1, floatChannels), 8), shape],
      // A kind bit nobody defined, and a rotary table the file doesn't have
      // (table 2 in bits 8 to 15; the fixture has two).
      ["kind", withHeaderWord(layerWord(0, kind), 4), shape],
      ["rotary-table", withHeaderWord(layerWord(0, kind), 2 * 256), shape],
      // Within the bounds, but more than the file holds.
      [
        "declared-larger",
        withHeaderWord(layerWord(0, feedForward), 16_384),
        sizes,
      ],
      ["declared-smaller", withHeaderWord(layerWord(1, heads), 1), sizes],
      // Past 1,024 tokens attention's integer sums could overflow.
      ["token-limit", withMaxTokens(encoderFloat, 1032), shape],
      [
        "version",
        withHeaderWord(headerWord.version, 1),
        "The encoder file isn't an encoder file of this version.",
      ],
    ];
    for (const [name, encoder, message] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time, each in an object of its own
      const embedder = await customEmbedder(`malformed-${name}`, {
        tokenizer: new Uint8Array(tokenizer),
        encoder,
        tokens: new Uint8Array(tokensFloat),
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(twoEmbeds(embedder)).resolves.toStrictEqual([
        message,
        message,
      ]);
    }
  });

  it("fails closed while a model file is missing, and loads once it is there", async () => {
    await upload(int8Model, int8Files);
    await env.MODEL_FILES.delete(modelFileKey(int8Model.tokens));
    const embedder = env.INT8.getByName("missing");
    const missing = `fixture-int8's tokens file is missing: no ${modelFileKey(int8Model.tokens)} in the model files bucket.`;
    await expect(twoEmbeds(embedder)).resolves.toStrictEqual([
      missing,
      missing,
    ]);
    await upload(int8Model, int8Files, ["tokens"]);
    const { vector } = await embedder.embed("Hallo");
    expect(vector).toHaveLength(128);
  });

  it("fails closed on a model file whose bytes aren't the hash it is named by", async () => {
    const tampered = Uint8Array.from(new Uint8Array(tokensInt8));
    // One weight of one token's row: a change no size check sees.
    tampered.set([(tampered.at(-1) ?? 0) === 0 ? 1 : 0], tampered.length - 1);
    await upload(int8Model, { ...int8Files, tokens: tampered });
    const embedder = env.INT8.getByName("tampered");
    const wrongHash = new RegExp(
      `^fixture-int8's tokens file has SHA-256 [0-9a-f]{64} \\(${String(int8Model.tokens.size)} bytes\\), not ${int8Model.tokens.sha256}\\.$`,
      "u"
    );
    const [first, second] = await twoEmbeds(embedder);
    expect(first).toMatch(wrongHash);
    expect(second).toBe(first);
    // With the right file, it loads.
    await upload(int8Model, int8Files, ["tokens"]);
    const { model } = await embedder.embed("Hallo");
    expect(model.name).toBe("fixture-int8");
  });

  it("fails closed on a model file of the wrong size", async () => {
    await upload(int8Model, {
      ...int8Files,
      encoder: new Uint8Array(encoderInt8.slice(0, 1000)),
    });
    const embedder = env.INT8.getByName("short");
    const wrongSize = `fixture-int8's encoder file is 1000 bytes, not ${String(int8Model.encoder.size)}.`;
    await expect(twoEmbeds(embedder)).resolves.toStrictEqual([
      wrongSize,
      wrongSize,
    ]);
    await upload(int8Model, int8Files, ["encoder"]);
    const { vector } = await embedder.embed("Hallo");
    expect(vector).toHaveLength(128);
  });

  it("after an eviction, loads again from its own storage, not the bucket", async () => {
    await upload(int8Model, int8Files);
    const stub = env.INT8.getByName("evicted");
    const text = "Customer onboarding starts with a call.";
    const before = await stub.embed(text);
    await Promise.all(
      everyFile.map(async (which) => {
        await env.MODEL_FILES.delete(modelFileKey(int8Model[which]));
      })
    );
    try {
      await runInDurableObject(stub, (_, state) => {
        state.abort("evicted by the test");
      });
    } catch {
      // The abort breaks the call that made it.
    }
    const after = await env.INT8.getByName("evicted").embed(text);
    expect(bitsOf(after.vector)).toBe(bitsOf(before.vector));
    expect(after.model).toStrictEqual(before.model);
  });
});
