import { modelFileKey, shippedModel } from "@grasp-os/embed/model-files";
import type { EmbedModel } from "@grasp-os/embed/model-files";
import { sha256OfBytes } from "@grasp-os/shared/release";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

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
// on-prem profile's (scripts/workerd-model-files.test.ts). No model ships
// yet (GRA-1767), so core runs none: that path is tried here end to end.

/** What core's question embedder says to `text`: its vector's length, or why it refused. */
const embedded = async (text: string): Promise<number | string> =>
  await runInDurableObject(questionEmbedderOf(env), async (instance) => {
    if (!(instance instanceof Embedder)) {
      throw new TypeError("EMBEDDER isn't the embedder");
    }
    try {
      const { vector } = await instance.embed(text);
      return vector.length;
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
  it("runs no model while none ships, and refuses every text, saying why", async () => {
    expect(shippedModel).toBeNull();

    await expect(embedded("Wat staat er op de factuur?")).resolves.toBe(
      "No embedding model ships with this release, so nothing is embedded."
    );
  });

  it("has the clock warm nothing, and fail no task, while no model ships", async () => {
    await expect(warmQuestionEmbedder(env)).resolves.toBeUndefined();
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

  it("holds no model to anything while none ships", async () => {
    await expect(holdsModelFiles(env.MODEL_FILES)).resolves.toBeTruthy();
  });
});
