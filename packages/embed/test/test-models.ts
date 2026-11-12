/**
 * The tiny models in fixtures/ (scripts/make-fixture.py), random and
 * untrained, for tests that need an embedder to run a model: this
 * package's own, and other packages' (by path, from their tests),
 * which import the files as bytes (a `Data` module rule for `*.bin`) and
 * export `BreakableEmbedder` from their test Worker.
 */
import wasm from "../src/embed.wasm";
import { Embedder } from "../src/embedder.ts";
import { Engine, rowBytes } from "../src/engine.ts";
import type { FileBytes } from "../src/engine.ts";
import {
  modelFileKey,
  modelIdentity,
  readTokensHeader,
  tokensHeaderBytes,
} from "../src/model-files.ts";
import type { EmbedModel, ModelIdentity } from "../src/model-files.ts";
import encoderFloat from "./fixtures/encoder-float.bin";
import encoderInt8 from "./fixtures/encoder-int8.bin";
import files from "./fixtures/files.json";
import tokenizer from "./fixtures/tokenizer.bin";
import tokensFloat from "./fixtures/tokens-float.bin";
import tokensInt8 from "./fixtures/tokens-int8.bin";

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

type Which = "tokenizer" | "encoder" | "tokens";

/** Each test model's files, as bytes. */
const bytesOf = new Map<EmbedModel, Record<Which, ArrayBuffer>>([
  [floatModel, { tokenizer, encoder: encoderFloat, tokens: tokensFloat }],
  [int8Model, { tokenizer, encoder: encoderInt8, tokens: tokensInt8 }],
]);

/**
 * How a test breaks a `BreakableEmbedder`: its object ends on every call
 * (`crash`), or answers late (`slow`), or ends on every text holding
 * `poisonWord` (`poison`), or answers those texts as its module failing
 * on them, as `embedMany` does after its own retry (`trap`; `trap-once`:
 * only the first time any object meets the text, as an object whose
 * memory runs short might), or runs out
 * of a call's tokens after its first
 * `budgetTexts` texts, deferring the rest (`budget`). A call of several
 * texts breaks whole, as an object ending or hanging does.
 */
export type Breakage =
  | "crash"
  | "slow"
  | "poison"
  | "trap"
  | "trap-once"
  | "budget";

/** The word a `poison` embedder ends on. */
export const poisonWord = "poisonpassage";

/** Each call of a `BreakableEmbedder` in the isolate: which object took it, and its texts. */
export const calls: { object: string; texts: string[] }[] = [];

/** The texts a `trap-once` embedder failed on already, in any object of the isolate. */
const trappedOnce = new Set<string>();

/** How many texts of a call a `budget` embedder embeds before it defers the rest. */
export const budgetTexts = 2;

/** How late a slow embedder answers: well past the time tests give a batch. */
export const slowMs = 5000;

/**
 * An embedder of the int8 test model that a test can break, until it
 * mends it: kept in its storage, so a crash outlives the object's restart.
 */
export class BreakableEmbedder extends Embedder {
  protected override readonly model: EmbedModel = int8Model;

  override async embed(text: string): ReturnType<Embedder["embed"]> {
    const breakage = await this.ctx.storage.get<Breakage>("breakage");
    if (
      breakage === "crash" ||
      (breakage === "poison" && text.includes(poisonWord))
    ) {
      this.ctx.abort("Broken by the test");
    }
    if (breakage === "slow") {
      await scheduler.wait(slowMs);
    }
    return await super.embed(text);
  }

  override async embedMany(
    texts: readonly string[]
  ): ReturnType<Embedder["embedMany"]> {
    calls.push({ object: this.ctx.id.toString(), texts: [...texts] });
    const breakage = await this.ctx.storage.get<Breakage>("breakage");
    const poisoned = texts.some((text) => text.includes(poisonWord));
    if (breakage === "crash" || (breakage === "poison" && poisoned)) {
      this.ctx.abort("Broken by the test");
    }
    if (breakage === "slow") {
      await scheduler.wait(slowMs);
    }
    const traps = (text: string): boolean =>
      text.includes(poisonWord) &&
      (breakage === "trap" ||
        (breakage === "trap-once" && !trappedOnce.has(text)));
    if (breakage === "trap" || breakage === "trap-once") {
      const trapping = texts.map(traps);
      for (const text of texts.filter((_, at) => trapping[at] === true)) {
        trappedOnce.add(text);
      }
      const embedded = await super.embedMany(
        texts.filter((_, at) => trapping[at] !== true)
      );
      const { identity } = await this.loaded();
      return texts.map((_, at) =>
        trapping[at] === true
          ? {
              kind: "failed" as const,
              reason: "kernel" as const,
              model: identity,
            }
          : (embedded.shift() ?? { kind: "deferred" as const })
      );
    }
    if (breakage === "budget") {
      const embedded = await super.embedMany(texts.slice(0, budgetTexts));
      return [
        ...embedded,
        ...texts.slice(budgetTexts).map(() => ({ kind: "deferred" as const })),
      ];
    }
    return await super.embedMany(texts);
  }

  /** Test-only: breaks this object, or mends it (null). */
  async breakAs(breakage: Breakage | null): Promise<void> {
    await (breakage === null
      ? this.ctx.storage.delete("breakage")
      : this.ctx.storage.put("breakage", breakage));
  }
}

/** A file's bytes, whole, as the engine reads them. */
const whole = (bytes: ArrayBuffer): FileBytes => ({
  size: bytes.byteLength,
  parts: [new Uint8Array(bytes)],
});

/**
 * `texts` embedded by the int8 test model run in the caller's own isolate,
 * with no embedder object: for tests whose Worker binds no embedder of a
 * test model (core's). Each text's vector, and the model and build, as an
 * embedder of it would give them.
 */
export const embedInProcess = async (
  texts: readonly string[]
): Promise<{ model: ModelIdentity; vectors: number[][] }> => {
  const engine = new Engine(wasm, {
    tokenizer: whole(tokenizer),
    encoder: whole(encoderInt8),
  });
  const table = new Uint8Array(tokensInt8);
  const header = readTokensHeader(table);
  if (header === null) {
    throw new Error("The test model's token table isn't one");
  }
  const size = rowBytes(header.format, header.dim);
  const rows = (ids: number[]) =>
    new Map(
      ids.map((id) => {
        const at = tokensHeaderBytes + id * size;
        return [id, table.subarray(at, at + size)] as const;
      })
    );
  return {
    model: await modelIdentity(int8Model),
    vectors: texts.map((text) => [
      ...engine.embed(engine.tokenize(text), header.format, rows),
    ]),
  };
};

/** Puts a test model's files in `bucket`, each where the model names it. */
export const putTestModel = async (
  bucket: R2Bucket,
  model: EmbedModel
): Promise<void> => {
  const bytes = bytesOf.get(model);
  if (bytes === undefined) {
    throw new Error("Not a test model");
  }
  const which: Which[] = ["tokenizer", "encoder", "tokens"];
  await Promise.all(
    which.map(
      async (file) => await bucket.put(modelFileKey(model[file]), bytes[file])
    )
  );
};
