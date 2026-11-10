// The embedder through its Durable Object, on the tiny model in fixtures/
// (scripts/make-fixture.py): its vectors and token IDs against Hugging
// Face's, the same bits from every integer kernel, its model files checked
// before use, and a reload after an eviction.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { Embedder, questionEmbedder } from "../src/embedder.ts";
import { modelFileKey } from "../src/model-files.ts";
import type { EmbedModel } from "../src/model-files.ts";
import encoderFloat from "./fixtures/encoder-float.bin";
import encoderInt8 from "./fixtures/encoder-int8.bin";
import int8Bits from "./fixtures/int8-bits.json";
import reference from "./fixtures/reference.json";
import tokenizer from "./fixtures/tokenizer.bin";
import tokensFloat from "./fixtures/tokens-float.bin";
import tokensInt8 from "./fixtures/tokens-int8.bin";
import { floatModel, int8Model } from "./worker.ts";
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

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * An embedder named `name` that runs a model made of `files`, each named
 * by its own hash and put in the bucket: for files that are wrong on
 * purpose but are what the model names.
 */
const customEmbedder = async (
  name: string,
  files: Record<Which, Uint8Array>
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
  await stub.use(model);
  return stub;
};

/** The float fixture's encoder with header word `index` set to `value`. */
const withHeaderWord = (index: number, value: number): Uint8Array => {
  const bytes = Uint8Array.from(new Uint8Array(encoderFloat));
  new DataView(bytes.buffer).setUint32(index * 4, value, true);
  return bytes;
};

/**
 * The float fixture's encoder declaring `maxTokens` tokens, with rotary
 * tables of that size (zeros): a consistent file whose buffers need far
 * more memory than the module may have.
 */
const withMaxTokens = (maxTokens: number): Uint8Array => {
  const source = new Uint8Array(encoderFloat);
  const view = new DataView(source.buffer);
  const word = (i: number): number => view.getUint32(i * 4, true);
  const [hidden, layers, oldMax, tables] = [word(3), word(6), word(7), word(9)];
  const headerBytes = pad16((10 + layers) * 4);
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
  new DataView(out.buffer).setUint32(7 * 4, maxTokens, true);
  return out;
};

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
          return vector;
        })
      );
      expect(forced).toStrictEqual([auto, auto]);
    }
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

  it("answers questions from an object of their own, with the same model", async () => {
    await upload(int8Model, int8Files);
    const text = "Who approves purchase orders above 5,000 euros?";
    const [question, other] = await Promise.all([
      questionEmbedder(env.INT8).embed(text),
      env.INT8.getByName("other").embed(text),
    ]);
    expect(question).toStrictEqual(other);
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
    expect(first).toStrictEqual(second);
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
      encoder: withMaxTokens(8192),
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
      // A head count whose product with the head width wraps on 32 bits.
      ["heads", withHeaderWord(4, 2 ** 26 + 1), shape],
      ["feed-forward", withHeaderWord(5, 0xff_ff_ff_f0), shape],
      ["layers", withHeaderWord(6, 2 ** 30), shape],
      // Within the bounds, but more than the file holds.
      ["declared-larger", withHeaderWord(5, 16_384), sizes],
      [
        "version",
        withHeaderWord(1, 2),
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
    expect(after).toStrictEqual(before);
  });
});
