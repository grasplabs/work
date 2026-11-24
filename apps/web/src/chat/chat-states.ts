import type { MessageStatus } from "@grasp-os/ui/components/message";

// What the chat's stream reports, in the words Damsko's chat parts take.
// Core streams a turn as its replies, their tool calls and code steps,
// and each step's result (`ChatMessage`, `ChatPartial`); Damsko's parts
// speak the AI SDK's vocabulary without depending on it: a Message's
// status, a step's, the box's. Every product
// state is mapped here, once, so the thread never decides it twice.

/** Where one answer of the agent's stands, as the thread knows it. */
export interface AnswerProgress {
  /** The agent works on it now. */
  live: boolean;
  /** It shows steps, words or a check already. */
  shows: boolean;
  /** How its last reply ended, once it did. */
  end: "done" | "cut_off" | "cancelled" | "failed" | undefined;
  /**
   * It failed for want of an AI provider: the answer offers to connect
   * one, which is no error.
   */
  providerMissing: boolean;
}

/**
 * An answer's Message status: thinking until something shows, streaming
 * while it is written, then how it ended. Cut off at the model's limit is
 * done (its words stand, a note says why they end); failed for want of a
 * provider is done too (the way to connect one stands under it).
 */
export const answerStatusOf = ({
  live,
  shows,
  end,
  providerMissing,
}: AnswerProgress): MessageStatus => {
  if (live) {
    return shows ? "streaming" : "thinking";
  }
  if (end === "failed") {
    return providerMissing ? "done" : "error";
  }
  return end === "cancelled" ? "stopped" : "done";
};

/**
 * Where one step of an answer (a tool call or a code step) stands:
 * `writing` while the model still writes its input, `running` once it
 * runs, then `done` or `failed`; `retried` for one that failed and a later
 * step of its turn recovered from (recovered.ts), which is no failure to
 * the person; `stopped` for one the turn stopped before it finished.
 */
export type StepStatus =
  | "writing"
  | "running"
  | "done"
  | "failed"
  | "retried"
  | "stopped";

/** A step's status from its result and where its turn is. */
export const stepStatusOf = ({
  result,
  writing,
  running,
  recovered,
}: {
  /** Its result, once core sent one. */
  result: { failed: boolean } | undefined;
  /** The model still writes the reply the step is in. */
  writing: boolean;
  /** The agent works on the chat now. */
  running: boolean;
  /** It failed, and a later step of its turn recovered. */
  recovered: boolean;
}): StepStatus => {
  if (writing) {
    return "writing";
  }
  if (result !== undefined) {
    if (!result.failed) {
      return "done";
    }
    return recovered ? "retried" : "failed";
  }
  // Without a result once the agent stopped, it never finished.
  return running ? "running" : "stopped";
};

/** A finished step reads in the past tense: done, or failed and recovered. */
export const stepFinished = (status: StepStatus): boolean =>
  status === "done" || status === "retried";

/** Where the box to ask in stands, as Damsko's PromptInput takes it. */
export type PromptStatus = "ready" | "submitted" | "streaming" | "error";

/**
 * The box's status from the chat: `streaming` while Grasp answers, so
 * Send is Stop; `submitted` while a question is on its way to core and
 * no answer runs yet; `error` once the last question didn't go, its words
 * kept; else `ready`. A stop on its way is still `streaming`: the answer
 * runs until core says it stopped.
 */
export const promptStatusOf = ({
  running,
  busy,
  failed,
}: {
  /** Grasp answers in the chat now. */
  running: boolean;
  /** A question or a stop is on its way to core. */
  busy: boolean;
  /** The last question didn't go. */
  failed: boolean;
}): PromptStatus => {
  if (running) {
    return "streaming";
  }
  if (busy) {
    return "submitted";
  }
  return failed ? "error" : "ready";
};
