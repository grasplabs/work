import type { ChatMessage } from "@grasp-os/shared/chat";

import { turnsOf } from "./turns.ts";

// Which of the agent's failed steps it recovered from (thread.tsx): a step
// that failed is recovered once a later step of the same turn did the same
// thing to the same target and succeeded (writing the same file of the same
// App again, editing the same workflow again, running code again). Such a
// step is no failure to the person, whose thread says it was retried; only
// a failure that stands at the turn's end is said as one.

/** What a step did to what: its tool and its target, as one key. */
const targetOf = (tool: string, input: Record<string, unknown>): string => {
  const { files } = input;
  const paths =
    typeof files === "object" && files !== null
      ? Object.keys(files).toSorted()
      : [];
  return JSON.stringify([
    tool,
    input.app ?? null,
    input.workflow ?? null,
    input.path ?? null,
    paths,
  ]);
};

/** The IDs of the failed steps in `messages` a later step of their turn recovered from. */
export const recoveredSteps = (
  messages: readonly ChatMessage[]
): ReadonlySet<string> => {
  const failed = new Set<string>();
  for (const message of messages) {
    if (message.role === "result" && message.failed) {
      failed.add(message.callId);
    }
  }
  const succeeded = (callId: string): boolean =>
    messages.some(
      (message) =>
        message.role === "result" &&
        message.callId === callId &&
        !message.failed
    );
  const recovered = new Set<string>();
  for (const { replies } of turnsOf(messages)) {
    // Each step of the turn, in the order it was taken: a reply's tool
    // calls before each of its code steps, then those after its last.
    const steps = replies.flatMap((reply) =>
      [...reply.code, undefined].flatMap((code, before) => [
        ...reply.tools
          .filter(({ codeBefore }) =>
            code === undefined ? codeBefore >= before : codeBefore === before
          )
          .map(({ callId, tool, input }) => ({
            callId,
            target: targetOf(tool, input),
          })),
        ...(code === undefined
          ? []
          : [{ callId: code.callId, target: targetOf("executeCode", {}) }]),
      ])
    );
    for (const [at, step] of steps.entries()) {
      if (
        failed.has(step.callId) &&
        steps
          .slice(at + 1)
          .some(
            ({ callId, target }) => target === step.target && succeeded(callId)
          )
      ) {
        recovered.add(step.callId);
      }
    }
  }
  return recovered;
};
