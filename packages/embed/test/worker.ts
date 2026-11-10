// oxlint-disable max-classes-per-file -- one embedder class per model and kernel the tests run
// The Worker the tests run against: embedders of the tiny model in
// fixtures/ (scripts/make-fixture.py), in its float and int8 forms, and
// with each integer kernel forced.
import { Embedder } from "../src/embedder.ts";
import type { Kernel } from "../src/engine.ts";
import type { EmbedModel } from "../src/model-files.ts";
import files from "./fixtures/files.json";

export const floatModel: EmbedModel = {
  name: "fixture-float",
  tokenizer: files["tokenizer.bin"],
  encoder: files["encoder-float.bin"],
  tokens: files["tokens-float.bin"],
};

export const int8Model: EmbedModel = {
  name: "fixture-int8",
  tokenizer: files["tokenizer.bin"],
  encoder: files["encoder-int8.bin"],
  tokens: files["tokens-int8.bin"],
};

export class FloatEmbedder extends Embedder {
  protected override readonly model = floatModel;
}

export class Int8Embedder extends Embedder {
  protected override readonly model = int8Model;

  /** Test-only: the text's token IDs, as `embed` reads them. */
  async tokenize(text: string): Promise<number[]> {
    const { engine } = await this.loaded();
    return [...engine.tokenize(text)];
  }
}

export class DotEmbedder extends Embedder {
  protected override readonly model = int8Model;
  protected override readonly kernel: Kernel = "dot";
}

export class PairsEmbedder extends Embedder {
  protected override readonly model = int8Model;
  protected override readonly kernel: Kernel = "pairs";
}

export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
