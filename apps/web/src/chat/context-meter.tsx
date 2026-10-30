import type { ChatMessage, ChatReplyUsage } from "@grasp-os/shared/chat";
import { Progress } from "@grasp-os/ui/components/progress";
import { useLingui } from "@lingui/react/macro";

import { formatNumber, formatPercent } from "../format.ts";
import { dollars } from "../settings/money.ts";

// Under the composer: how full the model's context window was at the
// chat's latest reply, what that reply wrote and cost, and what the chat
// has cost so far, from the usage core keeps on each reply as the model
// gateway counted it (`ChatMessage.usage`). Counts only, never content.

/** How full the window was, what the latest reply used, and the chat's cost. */
export interface ChatContext {
  /** The prompt the latest reply was sent, in tokens: the window's fill. */
  used: number;
  /** The model's context window, in tokens; null when core doesn't know it. */
  window: number | null;
  /** What the latest reply wrote, in tokens. */
  written: number;
  /** What the latest reply cost, in US dollars. */
  cost: number;
  /** What every reply of the chat cost together, in US dollars. */
  total: number;
}

/** The prompt a reply was sent: its uncached input and its cache's, together. */
const sentOf = (usage: ChatReplyUsage): number =>
  usage.input + usage.cacheRead + usage.cacheWrite;

/** The chat's context, from its replies' usage; undefined before any reply counted one. */
export const contextOf = (
  messages: readonly ChatMessage[]
): ChatContext | undefined => {
  const usages = messages.flatMap((message) =>
    message.role === "assistant" && message.usage !== undefined
      ? [message.usage]
      : []
  );
  const latest = usages.at(-1);
  if (latest === undefined) {
    return undefined;
  }
  return {
    used: sentOf(latest),
    window: latest.contextWindow,
    written: latest.output,
    cost: latest.cost,
    total: usages.reduce((sum, usage) => sum + usage.cost, 0),
  };
};

/** The chat's context meter; nothing before any reply counted its usage. */
export const ContextMeter = ({
  messages,
}: {
  messages: readonly ChatMessage[];
}) => {
  const { t } = useLingui();
  const context = contextOf(messages);
  if (context === undefined) {
    return null;
  }
  const used = formatNumber(context.used);
  const written = formatNumber(context.written);
  const cost = dollars(context.cost);
  const total = dollars(context.total);
  const fill =
    context.window === null || context.window <= 0
      ? undefined
      : Math.min(context.used / context.window, 1);
  const size = context.window === null ? "" : formatNumber(context.window);
  const share = fill === undefined ? "" : formatPercent(fill);
  return (
    <div className="text-muted-foreground flex flex-col gap-1 px-1 text-xs">
      {fill === undefined ? (
        <p>{t`The latest reply was sent ${used} tokens. The model's context window isn't known.`}</p>
      ) : (
        <div className="flex items-center gap-2">
          <Progress
            aria-label={t`Context window`}
            className="w-24 flex-none"
            value={fill * 100}
          />
          <p>{t`${used} of ${size} tokens of the model's context window (${share})`}</p>
        </div>
      )}
      <p>{t`The latest reply wrote ${written} tokens and cost ${cost}. This chat so far: ${total}.`}</p>
    </div>
  );
};
