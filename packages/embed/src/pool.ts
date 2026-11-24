/**
 * The bulk embedders: a pool of `Embedder` objects that embed many
 * passages at once, apart from the question embedder (`questionEmbedder`),
 * so a first load never slows a question.
 *
 * A batch goes to one object of the pool, picked at random, so batches
 * sent at once mostly land on different objects, in calls of the
 * embedder's own size (`embedMany`: at most `maxTextsPerCall` texts; the
 * embedder defers what passes its tokens a call, and the next call takes
 * it). Each text gets:
 * - its vector;
 * - `unembeddable`: the embedder's own answer that it can't embed that
 *   text: it is too long, or not text; or its module failed on it
 *   (`kernel`: twice in one object, the second time on a fresh instance)
 *   and again in a second object, so that neither object's memory or
 *   state at the time explains it. Its neighbours in the call are
 *   embedded all the same;
 * - null: not embedded this time: its call broke whole (the object
 *   ended, ran out of memory, couldn't load its model, or took the time
 *   left), or the time was up. That blames no text: the caller tries
 *   again later, as it tries any failed work.
 * A batch where nothing came back at all is `unavailable`. Nothing of a
 * text or of an embedder's error is kept or logged.
 *
 * Every object is got from the namespace given, so the caller picks its
 * jurisdiction (core gives the EU's).
 */
import { withinTime } from "@grasp-os/shared/deadline";

import { maxTextsPerCall } from "./embedder.ts";
import type { EmbedResult, Embedder } from "./embedder.ts";
import type { ModelIdentity } from "./model-files.ts";

/** How many bulk embedders there are: as many as the Brain's queue runs items at once. */
export const bulkEmbedders = 4;

/** What the pool gave a text (above). */
export type PoolResult = number[] | "unembeddable" | null;

/**
 * What the pool gave for a batch: a result per text, in order, and the
 * model and build that answered them, vectors and verdicts alike (null
 * when none answered); or nothing at all, also when two builds answered.
 */
export type PoolReply =
  | { kind: "vectors"; model: ModelIdentity | null; results: PoolResult[] }
  | { kind: "unavailable" };

const sameModel = (a: ModelIdentity, b: ModelIdentity): boolean =>
  a.name === b.name && a.build === b.build;

/**
 * `texts` embedded by one of the bulk embedders of `namespace`, within
 * `timeoutMs` (above).
 */
export const embedWithPool = async (
  namespace: DurableObjectNamespace<Embedder>,
  texts: readonly string[],
  { timeoutMs }: { timeoutMs: number }
): Promise<PoolReply> => {
  const deadline = Date.now() + timeoutMs;
  const first = Math.floor(Math.random() * bulkEmbedders);
  const results: PoolResult[] = texts.map(() => null);
  const models: ModelIdentity[] = [];
  /**
   * `indexes`' texts on bulk object `object`, call after call until none
   * is left, a call breaks, or the time is up: each answer kept, and the
   * texts its module failed on (`kernel`) given back, unanswered.
   */
  const embedOn = async (
    object: number,
    indexes: readonly number[]
  ): Promise<number[]> => {
    const embedder = namespace.getByName(`bulk-${object % bulkEmbedders}`);
    const kernel: number[] = [];
    let pending = [...indexes];
    while (pending.length > 0 && Date.now() < deadline) {
      const call = pending.slice(0, maxTextsPerCall);
      let answered: EmbedResult[];
      try {
        // oxlint-disable-next-line no-await-in-loop -- the next call takes what this one deferred
        answered = await withinTime(
          async () =>
            await embedder.embedMany(call.map((index) => texts[index] ?? "")),
          deadline - Date.now()
        );
      } catch {
        // Broken whole: what it held is not done this time.
        break;
      }
      const deferred: number[] = [];
      for (const [at, index] of call.entries()) {
        const result = answered[at];
        if (result?.kind === "embedded") {
          results[index] = [...result.vector];
          models.push(result.model);
        } else if (result?.kind === "failed") {
          // A verdict is its build's: kept with it, as a vector is.
          models.push(result.model);
          if (result.reason === "kernel") {
            kernel.push(index);
          } else {
            results[index] = "unembeddable";
          }
        } else {
          deferred.push(index);
        }
      }
      if (deferred.length === call.length) {
        // Nothing of the call came back: no call would do better now.
        break;
      }
      pending = [...deferred, ...pending.slice(call.length)];
    }
    return kernel;
  };
  const kernel = await embedOn(first, [...texts.keys()]);
  if (kernel.length > 0) {
    // The module failed on these twice in one object: once more in
    // another, which doesn't share that object's memory or state. Failed
    // there too, a text is the model's to refuse.
    const again = await embedOn(first + 1, kernel);
    for (const index of again) {
      results[index] = "unembeddable";
    }
  }
  const [model] = models;
  if (
    results.every((result) => result === null) ||
    (model !== undefined && !models.every((one) => sameModel(one, model)))
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "vectors", model: model ?? null, results };
};
