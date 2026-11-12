/**
 * A question's vector, for recall: one text, from the question embedder
 * (`questionEmbedder`), within a deadline. Recall goes ahead without it
 * whatever happens, so this never throws: an embedder that breaks or
 * can't load its model, refuses the text, or answers past the deadline
 * gives no vector and why. The embedder is told when this caller gives
 * up, and skips the text if it gets to it later.
 * An embedder asleep that must load its model first (seconds) answers
 * past any deadline a question can wait: that question goes without, and
 * the load it started goes on, so the next question finds the model
 * loaded.
 */
import { withinTime } from "@grasp-os/shared/deadline";

import type { Embedder } from "./embedder.ts";
import type { ModelIdentity } from "./model-files.ts";

/**
 * A question's vector and the model and build that made it; or why there
 * is none: the deadline passed (`timed_out`), the embedder broke or has
 * no model to run (`failed`), or it can't embed this text (`refused`).
 * Nothing of the question or of the embedder's error.
 */
export type QuestionVector =
  | { kind: "vector"; model: ModelIdentity; vector: number[] }
  | { kind: "none"; reason: "timed_out" | "failed" | "refused" };

/** `question`'s vector by `embedder`, within `timeoutMs` (above). */
export const embedQuestion = async (
  embedder: DurableObjectStub<Embedder>,
  question: string,
  { timeoutMs }: { timeoutMs: number }
): Promise<QuestionVector> => {
  // The embedder skips the text once this caller has given up, so a
  // question abandoned behind others or behind a load costs it nothing
  // more. By this isolate's clock: a skew of a few milliseconds between
  // machines moves when it gives up by as much.
  const giveUpAt = Date.now() + timeoutMs;
  try {
    const [result] = await withinTime(
      async () => await embedder.embedMany([question], giveUpAt),
      timeoutMs
    );
    if (result?.kind === "embedded") {
      return {
        kind: "vector",
        model: result.model,
        vector: [...result.vector],
      };
    }
    // Deferred: the embedder got to it once this caller had given up.
    return {
      kind: "none",
      reason: result?.kind === "deferred" ? "timed_out" : "refused",
    };
  } catch (error) {
    return {
      kind: "none",
      reason:
        error instanceof DOMException && error.name === "TimeoutError"
          ? "timed_out"
          : "failed",
    };
  }
};
