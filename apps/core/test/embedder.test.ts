import { modelFileKey, shippedModel } from "@grasp-os/embed/model-files";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  Embedder,
  questionEmbedderOf,
  warmQuestionEmbedder,
} from "../src/embedder.ts";

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

// Core's embedder (src/embedder.ts): the Embedder class bound as EMBEDDER,
// reading the model's files from MODEL_FILES. The model itself is the
// embed package's to test (packages/embed), and the files' way in is the
// admin's deploy's and the on-prem profile's (scripts/workerd-model-files
// .test.ts). Here: that core's binding runs it, and fails closed.

describe("core's embedder", () => {
  it("refuses to embed anything while the model's files aren't in its bucket", async () => {
    await env.MODEL_FILES.delete(modelFileKey(shippedModel.tokens));

    await expect(embedded("Wat staat er op de factuur?")).resolves.toMatch(
      /missing/u
    );
  });

  it("refuses a model file that isn't the one the release names, keeping nothing of it", async () => {
    await Promise.all(
      [shippedModel.tokenizer, shippedModel.encoder, shippedModel.tokens].map(
        async (file) =>
          await env.MODEL_FILES.put(modelFileKey(file), "other weights")
      )
    );

    await expect(embedded("Wat?")).resolves.toMatch(/not \d+|SHA-256/u);
  });

  it("has the clock warm nothing, and fail no task, while the model's files aren't there", async () => {
    await env.MODEL_FILES.delete(modelFileKey(shippedModel.tokens));
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    const warmed = warmQuestionEmbedder(env);

    await expect(warmed).resolves.toBeUndefined();
    warnings.mockRestore();
  });
});
