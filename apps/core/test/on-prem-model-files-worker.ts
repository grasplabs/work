// The Worker scripts/workerd-model-files.test.ts serves on plain workerd, as the
// on-prem profile runs core: core's own copy of the model's files from the
// release directory (src/embedder.ts) into the file-backed
// bucket, and the embedder reading them there, on the embed package's tiny
// fixture model in place of the real one.
import { Embedder } from "@grasp-os/embed/embedder";
import type { EmbedModel } from "@grasp-os/embed/model-files";

import files from "../../../packages/embed/test/fixtures/files.json";
import { ensureModelFilesFrom, holdsModelFiles } from "../src/embedder.ts";

/** The fixture model, int8, as a release would name it. */
export const fixtureModel: EmbedModel = {
  name: "fixture-int8",
  tokenizer: files["tokenizer.bin"],
  encoder: files["encoder-int8.bin"],
  tokens: files["tokens-int8.bin"],
};

/** Core's embedder, on the fixture model. */
export class FixtureEmbedder extends Embedder {
  protected override readonly model = fixtureModel;
}

interface TestEnv {
  MODEL_FILES: R2Bucket;
  MODEL_SOURCE: Fetcher;
  EMBEDDER: DurableObjectNamespace<FixtureEmbedder>;
}

/** Runs the step it's sent and answers what came of it, or the error it threw. */
const run = async (env: TestEnv, step: string): Promise<unknown> => {
  switch (step) {
    case "ensure": {
      const outcome = await ensureModelFilesFrom(
        env.MODEL_SOURCE,
        env.MODEL_FILES,
        fixtureModel
      );
      const listed = await env.MODEL_FILES.list();
      return { outcome, keys: listed.objects.map(({ key }) => key).toSorted() };
    }
    case "holds": {
      return await holdsModelFiles(env.MODEL_FILES, fixtureModel);
    }
    case "embed": {
      const { vector, model } = await env.EMBEDDER.getByName("questions").embed(
        "Een vraag over de factuur van maart."
      );
      return { length: vector.length, model: model.name };
    }
    case "plant": {
      // A model file another release left behind, which no release that
      // runs names.
      await env.MODEL_FILES.put(`embed-models/${"0".repeat(64)}`, "old");
      return "planted";
    }
    default: {
      throw new Error(`No step ${step}`);
    }
  }
};

export default {
  fetch: async (request: Request, env: TestEnv): Promise<Response> => {
    const step = await request.text();
    try {
      return Response.json({ ok: await run(env, step) });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
