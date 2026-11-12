// oxlint-disable max-classes-per-file -- one embedder class per model and kernel the tests run
// The Worker the tests run against: embedders of the tiny models in
// fixtures/ (scripts/make-fixture.py), in their float and int8 forms, and
// with each integer kernel forced.
import { Embedder } from "../src/embedder.ts";
import type { Loaded } from "../src/embedder.ts";
import type { Kernel, RunningKernel } from "../src/engine.ts";
import type { EmbedModel } from "../src/model-files.ts";
import deepFiles from "./fixtures/deep/files.json";
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

/** The deep fixture: 5 layers, another set of local layers, pruned widths. */
export const deepFloatModel: EmbedModel = {
  name: "fixture-deep-float",
  tokenizer: deepFiles["tokenizer.bin"],
  encoder: deepFiles["encoder-float.bin"],
  tokens: deepFiles["tokens-float.bin"],
};

export const deepInt8Model: EmbedModel = {
  name: "fixture-deep-int8",
  tokenizer: deepFiles["tokenizer.bin"],
  encoder: deepFiles["encoder-int8.bin"],
  tokens: deepFiles["tokens-int8.bin"],
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

  /** Test-only: which integer kernels run. */
  async kernelInUse(): Promise<RunningKernel> {
    const { engine } = await this.loaded();
    return engine.kernel;
  }
}

/** An embedder whose model and kernel a test names: for other fixtures, and model files that are wrong on purpose. */
export class CustomEmbedder extends Int8Embedder {
  protected override model: EmbedModel = int8Model;
  protected override kernel: Kernel = "auto";

  /** Test-only: the model this object loads from now on, with `kernel`. */
  use(model: EmbedModel, kernel: Kernel = "auto"): void {
    this.model = model;
    this.kernel = kernel;
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

/** A text holding this word makes a `TrappingEmbedder`'s module trap as it runs the encoder. */
export const trapWord = "kerneltrap";
/** A text holding this word ends a `TrappingEmbedder`'s object as it reaches it. */
export const abortWord = "objectabort";

/**
 * An embedder of the int8 model that breaks on certain texts: its module
 * traps on a text holding `trapWord`, as a kernel that fails does, and its
 * object ends on one holding `abortWord`, as one that runs out of memory
 * does. Every other text runs as in any embedder.
 */
export class TrappingEmbedder extends Embedder {
  protected override readonly model = int8Model;
  private readonly broken = new WeakSet<object>();

  protected override async loaded(): Promise<Loaded> {
    const loaded = await super.loaded();
    const { engine } = loaded;
    if (!this.broken.has(engine)) {
      this.broken.add(engine);
      const tokenize = engine.tokenize.bind(engine);
      const embed = engine.embed.bind(engine);
      let trapNext = false;
      engine.tokenize = (text) => {
        if (text.includes(abortWord)) {
          this.ctx.abort("Ended by the test");
        }
        trapNext = text.includes(trapWord);
        return tokenize(text);
      };
      engine.embed = (...args) => {
        if (trapNext) {
          throw new WebAssembly.RuntimeError("unreachable");
        }
        return embed(...args);
      };
    }
    return loaded;
  }
}

export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
