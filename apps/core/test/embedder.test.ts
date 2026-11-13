import { modelFileKey, shippedModel } from "@grasp-os/embed/model-files";
import type { EmbedModel } from "@grasp-os/embed/model-files";
import { sha256OfBytes } from "@grasp-os/shared/release";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  embedInProcess,
  putTestModel,
} from "../../../packages/embed/test/test-models.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  Embedder,
  holdsModelFiles,
  questionEmbedderOf,
  warmQuestionEmbedder,
} from "../src/embedder.ts";

// Core's embedder (src/embedder.ts): the Embedder class bound as EMBEDDER,
// reading the model's files from MODEL_FILES, and what the probe asks of
// that bucket. The model itself is the embed package's to test
// (packages/embed); the files' way in is the admin's deploy's and the
// on-prem profile's (scripts/workerd-model-files.test.ts). Core's tests
// ship the embed package's test model, its files in MODEL_FILES as each
// file starts (start-each-file.ts), as a deploy puts the real one's.

/**
 * What `embedder` says to `text`: its vector, as numbers, and the model's
 * name, or why it refused.
 */
const embeddedBy = async (
  embedder: DurableObjectStub<Embedder>,
  text: string
): Promise<{ vector: number[]; model: string } | string> =>
  await runInDurableObject(embedder, async (instance) => {
    if (!(instance instanceof Embedder)) {
      throw new TypeError("EMBEDDER isn't the embedder");
    }
    try {
      const { vector, model } = await instance.embed(text);
      return { vector: [...vector], model: model.name };
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

const encoder = new TextEncoder();

/** A file as a model names it: its SHA-256 and size. */
const fileOf = async (of: Uint8Array) => ({
  sha256: await sha256OfBytes(new Uint8Array(of)),
  size: of.byteLength,
});

/** A model of three small files, with their bytes, distinct by `tag`. */
const modelOf = async (tag: string) => {
  const bytes = {
    tokenizer: encoder.encode(`tokenizer ${tag}`),
    encoder: encoder.encode(`encoder ${tag}`),
    tokens: encoder.encode(`tokens ${tag}`),
  };
  const model: EmbedModel = {
    name: `test-${tag}`,
    tokenizer: await fileOf(bytes.tokenizer),
    encoder: await fileOf(bytes.encoder),
    tokens: await fileOf(bytes.tokens),
  };
  return { model, bytes };
};

/** Puts `model`'s files in MODEL_FILES as a deploy does: each with its SHA-256. */
const putModel = async ({
  model,
  bytes,
}: Awaited<ReturnType<typeof modelOf>>): Promise<void> => {
  for (const which of ["tokenizer", "encoder", "tokens"] as const) {
    // oxlint-disable-next-line no-await-in-loop -- three files
    await env.MODEL_FILES.put(modelFileKey(model[which]), bytes[which], {
      sha256: model[which].sha256,
    });
  }
};

describe("core's embedder", () => {
  it("answers a question by the model core ships, from MODEL_FILES, after the clock's warm-up, which fails no task", async () => {
    const question = "Wat staat er op de factuur?";
    // Once per isolate (`tried`): an earlier file in this runtime may have
    // warmed already, so this proves only that it doesn't throw.
    await expect(warmQuestionEmbedder(env)).resolves.toBeUndefined();

    const {
      vectors: [expected],
    } = await embedInProcess([question]);

    await expect(
      embeddedBy(questionEmbedderOf(env), question)
    ).resolves.toStrictEqual({ vector: expected, model: shippedModel.name });
  });

  it("refuses every text while a file of the model is missing from MODEL_FILES, saying which, and embeds once it is back", async () => {
    // An embedder that hasn't loaded the model yet, as after a deploy.
    const embedder = inJurisdiction(env, env.EMBEDDER).getByName(
      crypto.randomUUID()
    );
    await env.MODEL_FILES.delete(modelFileKey(shippedModel.tokens));

    await expect(embeddedBy(embedder, "Een vraag")).resolves.toBe(
      `${shippedModel.name}'s tokens file is missing: no ${modelFileKey(shippedModel.tokens)} in the model files bucket.`
    );

    await putTestModel(env.MODEL_FILES, shippedModel);

    await expect(embeddedBy(embedder, "Een vraag")).resolves.toMatchObject({
      model: shippedModel.name,
    });
  });

  it("finds a model's files held only when each is there at its size and with its SHA-256", async () => {
    const held = await modelOf(crypto.randomUUID());
    await putModel(held);
    const missing = await modelOf(crypto.randomUUID());
    await putModel(missing);
    await env.MODEL_FILES.delete(modelFileKey(missing.model.tokens));
    const swapped = await modelOf(crypto.randomUUID());
    await putModel(swapped);
    // Other bytes of the same size, stored with their own SHA-256.
    const other = swapped.bytes.tokens.map((byte) =>
      byte === 0x41 ? 0x42 : 0x41
    );
    await env.MODEL_FILES.put(modelFileKey(swapped.model.tokens), other, {
      sha256: await sha256OfBytes(new Uint8Array(other)),
    });

    const answers = await Promise.all(
      [held, missing, swapped].map(
        async ({ model }) => await holdsModelFiles(env.MODEL_FILES, model)
      )
    );

    expect(answers).toStrictEqual([true, false, false]);
  });

  it("finds the model core ships held while MODEL_FILES has its files, and not once one is gone", async () => {
    const before = await holdsModelFiles(env.MODEL_FILES);
    await env.MODEL_FILES.delete(modelFileKey(shippedModel.encoder));

    await expect(holdsModelFiles(env.MODEL_FILES)).resolves.toBeFalsy();
    expect(before).toBeTruthy();
  });
});
