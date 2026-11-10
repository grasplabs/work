// The embedder through its Durable Object, on the tiny model in fixtures/
// (scripts/make-fixture.py): its vectors and token IDs against Hugging
// Face's, the same bits from every integer kernel, its model files checked
// before use, and a reload after an eviction.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { bulkEmbedder, questionEmbedder } from "../src/embedder.ts";
import { modelFileKey } from "../src/model-files.ts";
import type { EmbedModel } from "../src/model-files.ts";
import encoderFloat from "./fixtures/encoder-float.bin";
import encoderInt8 from "./fixtures/encoder-int8.bin";
import reference from "./fixtures/reference.json";
import tokenizer from "./fixtures/tokenizer.bin";
import tokensFloat from "./fixtures/tokens-float.bin";
import tokensInt8 from "./fixtures/tokens-int8.bin";
import { Int8Embedder, floatModel, int8Model } from "./worker.ts";

/**
 * How close the embedder comes to the reference (Hugging Face transformers,
 * float32): the float path within float32 rounding, each component within
 * 1e-5 (measured 4e-7); the int8 path, which production runs, at cosine
 * 0.995 or more for every text (measured 0.9986 on this fixture; 0.9961 on
 * the real model, scripts/check-model.ts).
 */
const floatTolerance = 1e-5;
const int8LeastCosine = 0.995;

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
 * Fails unless embedding a text in `embedder` fails with `message`, twice:
 * a failed load leaves nothing behind that a second call could use. Run
 * inside the object, as an error thrown back across RPC reaches the test
 * pool as unhandled.
 */
const failsClosed = async (
  embedder: DurableObjectStub<Int8Embedder>,
  message: string | RegExp
): Promise<void> => {
  await runInDurableObject(embedder, async (instance) => {
    expect(instance).toBeInstanceOf(Int8Embedder);
    if (instance instanceof Int8Embedder) {
      await expect(instance.embed("Hallo")).rejects.toThrow(message);
      await expect(instance.embed("Hallo")).rejects.toThrow(message);
    }
  });
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

  it("answers questions and bulk work from separate objects, each with the same model", async () => {
    await upload(int8Model, int8Files);
    const text = "Who approves purchase orders above 5,000 euros?";
    const [question, bulk] = await Promise.all([
      questionEmbedder(env.INT8).embed(text),
      bulkEmbedder(env.INT8, 0).embed(text),
    ]);
    expect(question).toStrictEqual(bulk);
  });

  it("fails closed while a model file is missing, and loads once it is there", async () => {
    await upload(int8Model, int8Files);
    await env.MODEL_FILES.delete(modelFileKey(int8Model.tokens));
    const embedder = env.INT8.getByName("missing");
    await failsClosed(
      embedder,
      `fixture-int8's tokens file is missing: no ${modelFileKey(int8Model.tokens)} in the model files bucket.`
    );
    await upload(int8Model, int8Files, ["tokens"]);
    const { vector } = await embedder.embed("Hallo");
    expect(vector).toHaveLength(64);
  });

  it("fails closed on a model file whose bytes aren't the hash it is named by", async () => {
    const tampered = Uint8Array.from(new Uint8Array(tokensInt8));
    // One weight of one token's row: a change no size check sees.
    tampered.set([(tampered.at(-1) ?? 0) === 0 ? 1 : 0], tampered.length - 1);
    await upload(int8Model, { ...int8Files, tokens: tampered });
    const embedder = env.INT8.getByName("tampered");
    await failsClosed(
      embedder,
      /fixture-int8's tokens file has SHA-256 [0-9a-f]{64} \(35596 bytes\), not f836/u
    );
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
    await failsClosed(
      embedder,
      `fixture-int8's encoder file is 1000 bytes, not ${String(int8Model.encoder.size)}.`
    );
    await upload(int8Model, int8Files, ["encoder"]);
    const { vector } = await embedder.embed("Hallo");
    expect(vector).toHaveLength(64);
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
