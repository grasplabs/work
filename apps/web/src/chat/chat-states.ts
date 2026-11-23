import type { ChainOfThoughtStepStatus } from "@grasp-os/ui/components/chain-of-thought";
import type { MessageStatus } from "@grasp-os/ui/components/message";
import type { ToolState } from "@grasp-os/ui/components/tool";

// What the chat's stream reports, in the words Damsko's chat parts take.
// Core streams a turn as its replies, their tool calls and code steps,
// and each step's result (`ChatMessage`, `ChatPartial`); Damsko's parts
// speak the AI SDK's vocabulary without depending on it: a Message's
// status, a Tool's state, a step of a Chain of thought. Every product
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

/**
 * A step as a Tool's state. A step retried is the call that came back
 * (`output-available`); one stopped never came back, which the AI SDK has
 * no state for: an error, its words saying it was stopped.
 */
export const toolStates: Readonly<Record<StepStatus, ToolState>> = {
  writing: "input-streaming",
  running: "input-available",
  done: "output-available",
  retried: "output-available",
  failed: "output-error",
  stopped: "output-error",
};

/**
 * A step as a line of a Chain of thought. A step stopped before it
 * finished never completed and never failed: it stays `pending`, its
 * description saying it was stopped.
 */
export const chainStatuses: Readonly<
  Record<StepStatus, ChainOfThoughtStepStatus>
> = {
  writing: "active",
  running: "active",
  done: "complete",
  retried: "complete",
  failed: "error",
  stopped: "pending",
};

/** Who wrote a message of the chat, as a Message stands: the person's at the end. */
export const messageAlign = (role: "user" | "assistant"): "start" | "end" =>
  role === "user" ? "end" : "start";
