// oxlint-disable max-classes-per-file -- one embedder class per model and kernel the tests run
// The Worker the tests run against: embedders of the tiny models in
// fixtures/ (scripts/make-fixture.py), in their float and int8 forms, and
// with each integer kernel forced.
import { Embedder } from "../src/embedder.ts";
import type { Loaded } from "../src/embedder.ts";
import type { Kernel, RunningKernel } from "../src/engine.ts";
import type { EmbedModel } from "../src/model-files.ts";
import deepFiles from "./fixtures/deep/files.json";
import trimmedFiles from "./fixtures/trimmed/files.json";
import { BreakableEmbedder, floatModel, int8Model } from "./test-models.ts";

export { floatModel, int8Model } from "./test-models.ts";

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

/**
 * The trimmed fixture: the first model with a few pieces' rows removed
 * from its token table, each written as kept pieces by its tokenizer's map.
 */
export const trimmedFloatModel: EmbedModel = {
  name: "fixture-trimmed-float",
  tokenizer: trimmedFiles["tokenizer.bin"],
  encoder: trimmedFiles["encoder-float.bin"],
  tokens: trimmedFiles["tokens-float.bin"],
};

export const trimmedInt8Model: EmbedModel = {
  name: "fixture-trimmed-int8",
  tokenizer: trimmedFiles["tokenizer.bin"],
  encoder: trimmedFiles["encoder-int8.bin"],
  tokens: trimmedFiles["tokens-int8.bin"],
};

/** The float model, breakable as `BreakableEmbedder` is: another build than the int8 one. */
export class FloatEmbedder extends BreakableEmbedder {
  protected override readonly model: EmbedModel = floatModel;
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
/**
 * A text holding this word makes a `TrappingEmbedder`'s module trap the
 * first time the object meets the text, as an instance worn out by what
 * ran before it can, and run it like any other after.
 */
export const trapOnceWord = "flakytrap";
/** A text holding this word ends a `TrappingEmbedder`'s object as it reaches it. */
export const abortWord = "objectabort";

/** Fills the module's whole memory with 0xff: whatever runs in it next gives other bits, or traps. */
const spoil = (engine: object): void => {
  const exports: unknown = Reflect.get(engine, "exports");
  if (
    typeof exports === "object" &&
    exports !== null &&
    "memory" in exports &&
    exports.memory instanceof WebAssembly.Memory
  ) {
    new Uint8Array(exports.memory.buffer).fill(0xff);
  }
};

/**
 * An embedder of the int8 model that breaks on certain texts: its module
 * traps on a text holding `trapWord` (always) or `trapOnceWord` (the first
 * time), as a kernel that fails does, spoiling its whole memory first, so
 * an instance used again after a trap gives other bits; and its object
 * ends on one holding `abortWord`, as one that runs out of memory does.
 * Every other text runs as in any embedder.
 */
export class TrappingEmbedder extends Embedder {
  protected override model: EmbedModel = int8Model;
  private readonly broken = new WeakSet<object>();

  /** Test-only: the model this object loads from now on. */
  use(model: EmbedModel): void {
    this.model = model;
  }
  /** The texts with `trapOnceWord` that trapped already, for the life of the object. */
  private readonly trapped = new Set<string>();

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
        const once = text.includes(trapOnceWord) && !this.trapped.has(text);
        if (once) {
          this.trapped.add(text);
        }
        trapNext = text.includes(trapWord) || once;
        return tokenize(text);
      };
      engine.embed = (...args) => {
        if (trapNext) {
          spoil(engine);
          throw new WebAssembly.RuntimeError("unreachable");
        }
        return embed(...args);
      };
    }
    return loaded;
  }
}

export { BreakableEmbedder } from "./test-models.ts";

export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
