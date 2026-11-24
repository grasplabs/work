import type {
  ChatCode,
  ChatMessage,
  ChatPartial,
  ChatToolCall,
  ChatToolEvent,
} from "@grasp-os/shared/chat";

// What Grasp is doing on a question it works on now, as the thread's
// working line says it (grasplabs/prototype `lib/sign.ts`).

/** What Grasp does while it works on a question. */
export type WorkState = "reading" | "thinking" | "writing" | "working";

/**
 * What Grasp is doing on a question it works on now. `partial` is the
 * answer being written, once it shows words or code; `replies` the answers
 * to the question stored so far, oldest first; `ran` whether a code step
 * has its result. Code being written or run is work; an answer that shows
 * no words yet is thought; words are writing. Before any of that, Grasp
 * reads the workspace; between its answers, it thinks, or works while the
 * code of the last one runs.
 */
export const signOf = ({
  partial,
  replies,
  ran,
}: {
  partial: ChatPartial | null;
  replies: readonly {
    code: readonly ChatCode[];
    tools: readonly ChatToolCall[];
  }[];
  ran: (callId: string) => boolean;
}): WorkState => {
  const latest = partial ?? replies.at(-1);
  if (latest === undefined) {
    return "reading";
  }
  const steps = [latest.code.at(-1), latest.tools.at(-1)];
  if (steps.some((step) => step !== undefined && !ran(step.callId))) {
    return "working";
  }
  return partial === null || partial.text.trim() === ""
    ? "thinking"
    : "writing";
};

/**
 * The name of the file Grasp reads now: while it works on a code step
 * (`working`), the last of the chat's files that step's code read
 * (`env.chat.readFile`, a call the chat shows), by its name as the question
 * that carried it shows it. None while it does anything else, or while
 * the step read no file.
 */
export const readingFileOf = ({
  doing,
  step,
  tools,
  messages,
}: {
  doing: WorkState | undefined;
  /** The code step being written or run: the newest answer's last. */
  step: ChatCode | undefined;
  tools: readonly ChatToolEvent[];
  messages: readonly ChatMessage[];
}): string | undefined => {
  if (doing !== "working" || step === undefined) {
    return undefined;
  }
  const read = tools.findLast(
    ({ callId, method, outcome, target }) =>
      callId === step.callId &&
      method === "chat.readFile" &&
      outcome === "ok" &&
      target?.type === "chat_file"
  );
  if (read?.target === undefined || read.target === null) {
    return undefined;
  }
  const fileId = read.target.id;
  for (const message of messages) {
    const file =
      message.role === "user"
        ? message.files?.find(({ id }) => id === fileId)
        : undefined;
    if (file !== undefined) {
      return file.name;
    }
  }
  return undefined;
};
