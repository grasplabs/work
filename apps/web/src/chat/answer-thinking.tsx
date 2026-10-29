import type { ChatMessage } from "@grasp-os/shared/chat";
import {
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { BrainIcon, ClockIcon } from "lucide-react";
import { useEffect } from "react";

import { useLessMotion } from "../brain/less-motion.ts";
import { thinkAddress } from "../brain/thinking/brain-thinking.ts";
import { useSteppedLine } from "../brain/thinking/line.ts";
import { thinkingIn } from "../brain/thinking/play.ts";
import type { ThinkingOf } from "../brain/thinking/play.ts";
import {
  noteArrivals,
  useThinkingLog,
} from "../brain/thinking/use-thinking.ts";

// An answer that showed Grasp's thinking in the brain (`show_thinking`,
// brain/thinking/*), in the thread: while Grasp works, the line over the
// answer says the step it is at, each up as long as it takes to read; once
// done, the answer's trace has "See it in the brain", which plays it again
// there (grasplabs/prototype `components/chat/chat-message.tsx`).

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

/** The trace's first line while Grasp shows its thinking: the step it is at, each up as long as it takes to read. */
export const ThinkingLine = ({
  thinking,
  arrivals,
  fallback,
}: {
  thinking: ThinkingOf;
  arrivals: readonly (number | undefined)[];
  /** What it says before the first step reached the tab. */
  fallback: string;
}) => {
  const step = useSteppedLine(thinking.steps, arrivals, useLessMotion());
  return (
    <TraceLine>
      <TraceIcon>
        <ClockIcon />
      </TraceIcon>
      <TraceTitle>
        {/* A live status, so a screen reader hears what Grasp does. */}
        <output className="shimmer-text">{step?.text ?? fallback}</output>
      </TraceTitle>
    </TraceLine>
  );
};

/** A finished answer's thinking, played again in the brain. */
export const SeeInBrain = ({
  chatId,
  thinking,
}: {
  chatId: string;
  thinking: ThinkingOf;
}) => (
  <TraceLine>
    <TraceIcon>
      <BrainIcon />
    </TraceIcon>
    <TraceTitle>
      <Link
        className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3"
        search={{ think: thinkAddress(chatId, thinking.questionId) }}
        to="/brain"
      >
        <Trans>See it in the brain</Trans>
      </Link>
    </TraceTitle>
  </TraceLine>
);
