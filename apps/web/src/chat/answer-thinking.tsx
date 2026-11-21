import type { ChatMessage } from "@grasp-os/shared/chat";
import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";

import { useLessMotion } from "../brain/less-motion.ts";
import { useSteppedLine } from "../brain/thinking/line.ts";
import { noteArrivals, useThinkingLog } from "../brain/thinking/log.ts";
import { thinkAddress, thinkingIn } from "../brain/thinking/play.ts";
import type { ThinkingOf } from "../brain/thinking/play.ts";
import { RouterLink } from "../frame/router-link.tsx";

// An answer that showed Grasp's thinking in the brain (`show_thinking`,
// brain/thinking/*), in the thread: while Grasp works, the line over the
// answer says the step it is at, each up as long as it takes to read; once
// done, the answer's trace has "See it in the brain", which plays it again
// there (grasplabs/prototype `components/chat/chat-message.tsx`). The
// thread is on every page, in the chat dock: this reads only what the tab
// saw of the thinking (log.ts, play.ts, line.ts), never how the brain draws
// it (shapes.ts and what it imports), which loads with the brain.

/** Each question's thinking, by the ID of the first answer to it. */
export const useAnswerThinking = (
  messages: readonly ChatMessage[],
  running: boolean
): {
  byReply: ReadonlyMap<number, ThinkingOf>;
  arrivals: (thinking: ThinkingOf) => (number | undefined)[];
} => {
  useEffect(() => {
    noteArrivals(messages, running);
  }, [messages, running]);
  const { arrived } = useThinkingLog();
  const byReply = new Map<number, ThinkingOf>();
  for (const thinking of thinkingIn(messages)) {
    const asked = messages.findIndex(({ id }) => id === thinking.questionId);
    const reply = messages
      .slice(asked + 1)
      .find(({ role }) => role === "assistant");
    if (reply !== undefined) {
      byReply.set(reply.id, thinking);
    }
  }
  return {
    byReply,
    arrivals: ({ calls }) => calls.map((call) => arrived.get(call)),
  };
};

/** What Grasp's thinking is at while it works: the step it is at, each up as long as it takes to read; `fallback` before the first step reached the tab. */
export const useThinkingStep = (
  thinking: ThinkingOf | undefined,
  arrivals: readonly (number | undefined)[],
  fallback: string
): string => {
  const step = useSteppedLine(thinking?.steps ?? [], arrivals, useLessMotion());
  return step?.text ?? fallback;
};

/** A finished answer's thinking, played again in the brain. */
export const SeeInBrain = ({
  chatId,
  thinking,
}: {
  chatId: string;
  thinking: ThinkingOf;
}) => (
  <RouterLink
    search={{ think: thinkAddress(chatId, thinking.questionId) }}
    to="/brain"
    variant="standalone"
  >
    <Trans>See it in the brain</Trans>
  </RouterLink>
);
