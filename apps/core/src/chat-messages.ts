import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { chatSavedMemorySchema } from "@grasp-os/shared/brain-memories";
import type { ChatSavedMemory } from "@grasp-os/shared/brain-memories";
import {
  chatAskSchema,
  chatPlanSchema,
  chatToolPreviewChars,
} from "@grasp-os/shared/chat";
import type {
  ChatAsked,
  ChatCode,
  ChatMessage,
  ChatPartial,
  ChatPlanned,
  ChatReasoning,
  ChatReplyEnd,
  ChatReplyUsage,
  ChatToolCall,
} from "@grasp-os/shared/chat";
import { thinkingStepSchema } from "@grasp-os/shared/thinking";
import type { ThinkingStep } from "@grasp-os/shared/thinking";
import { z } from "zod";

import {
  isDedicatedTool,
  rememberName,
  showThinkingName,
} from "./agent-messages.ts";
import { contextWindowOf, modelFailureOf } from "./models.ts";

// A chat's transcript as pi keeps it (workspace.ts), shown as the person
// reads it: their questions, the agent's answers with the code it ran and
// what the model thought before them, and each code step's result. The
// agent's instructions, and the APIs and the memory it was shown, stay out.

/** What a Build it shows: the plan it built, by its call, and what that made. */
export const shownBuiltSchema = z.object({
  plan: z.string(),
  app: z.object({ id: z.string(), name: z.string() }).optional(),
  workflow: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type ShownBuilt = z.infer<typeof shownBuiltSchema>;

/**
 * The step of thinking a `show_thinking` call showed, as core accepted it
 * (agent-thinking.ts); none for another call's result, or one refused.
 */
const thinkingOf = (message: ToolResultMessage): ThinkingStep | undefined => {
  if (message.toolName !== showThinkingName || message.isError) {
    return undefined;
  }
  const step = thinkingStepSchema.safeParse(message.details);
  return step.success ? step.data : undefined;
};

/**
 * The memory a call of `remember` saved (agent-remember.ts), for the
 * chat's notice; none for any other result, or one that failed.
 */
export const savedOf = (
  message: ToolResultMessage
): ChatSavedMemory | undefined => {
  if (message.toolName !== rememberName || message.isError) {
    return undefined;
  }
  const saved = chatSavedMemorySchema.safeParse(message.details);
  return saved.success ? saved.data : undefined;
};

/** The text parts of a message's content, joined. */
const textOf = (
  content: string | readonly { type: string; text?: string }[]
): string =>
  typeof content === "string"
    ? content
    : content
        .flatMap((part) =>
          part.type === "text" && typeof part.text === "string"
            ? [part.text]
            : []
        )
        .join("");

/**
 * The code a response asked to run: each `executeCode` call's code, as far
 * as it has streamed in (pi parses the call's arguments as they come).
 */
const codeOf = (message: AssistantMessage): ChatCode[] =>
  message.content.flatMap((part) => {
    // Reading an API's declaration (`readApi`) runs no code.
    if (part.type !== "toolCall" || part.name !== "executeCode") {
      return [];
    }
    const { code } = part.arguments;
    return [{ callId: part.id, code: typeof code === "string" ? code : "" }];
  });

/** `value` with each text in it cut to `chars`, at any depth. */
const cutTexts = (value: unknown, chars: number): unknown => {
  if (typeof value === "string") {
    return value.length > chars ? `${value.slice(0, chars)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => cutTexts(item, chars));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cutTexts(item, chars)])
    );
  }
  return value;
};

/**
 * The calls a response made of the agent's dedicated tools (agent-tools.ts),
 * as far as they have streamed in, each text of their input cut to
 * `chars` when given (while the response is written).
 */
const toolsOf = (message: AssistantMessage, chars?: number): ChatToolCall[] =>
  message.content.flatMap((part, at) => {
    if (part.type !== "toolCall" || !isDedicatedTool(part.name)) {
      return [];
    }
    const codeBefore = message.content
      .slice(0, at)
      .filter(
        (before) => before.type === "toolCall" && before.name === "executeCode"
      ).length;
    const input: Record<string, unknown> =
      chars === undefined
        ? part.arguments
        : Object.fromEntries(
            Object.entries(part.arguments).map(([key, value]) => [
              key,
              cutTexts(value, chars),
            ])
          );
    return [{ callId: part.id, tool: part.name, codeBefore, input }];
  });

/**
 * The questions a response asked the person (`askQuestions`), as the tool
 * took them: its first call the tool took; none when it asked none, or
 * only in shapes the tool refused (the model was told why).
 */
const askedOf = (message: AssistantMessage): ChatAsked | undefined => {
  for (const part of message.content) {
    if (part.type === "toolCall" && part.name === "askQuestions") {
      const ask = chatAskSchema.safeParse(part.arguments);
      if (ask.success) {
        return { callId: part.id, ...ask.data };
      }
    }
  }
  return undefined;
};

/**
 * The plan a response proposed (`proposePlan`), as the tool took it: its
 * first call the tool took; none when it proposed none.
 */
const plannedOf = (message: AssistantMessage): ChatPlanned | undefined => {
  for (const part of message.content) {
    if (part.type === "toolCall" && part.name === "proposePlan") {
      const plan = chatPlanSchema.safeParse(part.arguments);
      if (plan.success) {
        return { callId: part.id, ...plan.data };
      }
    }
  }
  return undefined;
};

/**
 * What a response thought, as far as it has streamed in: each thinking
 * part the provider showed, joined. A redacted part holds only pi's own
 * placeholder, never the model's words, so it shows nothing.
 */
const thoughtOf = (message: AssistantMessage): string =>
  message.content
    .flatMap((part) =>
      part.type === "thinking" && part.redacted !== true && part.thinking !== ""
        ? [part.thinking]
        : []
    )
    .join("\n\n");

/** Whether a response thought at all, shown or redacted. */
const thought = (message: AssistantMessage): boolean =>
  message.content.some(({ type }) => type === "thinking");

/**
 * What a stored response thought, and for how long (`thinkingMs`, as core
 * timed it); none for one that didn't think.
 */
const reasoningOf = (
  message: AssistantMessage,
  thinkingMs: number | null
): ChatReasoning | undefined =>
  thought(message) ? { text: thoughtOf(message), ms: thinkingMs } : undefined;

const ends: Record<AssistantMessage["stopReason"], ChatReplyEnd> = {
  stop: "done",
  toolUse: "done",
  // Neither ends a response this loop keeps; shown as done if one did.
  pending: "done",
  deferred: "done",
  length: "cut_off",
  aborted: "cancelled",
  error: "failed",
};

/**
 * What core names the messages it writes itself by, as their provider,
 * API and model (workspace.ts): no model wrote them, so they used nothing.
 */
export const coreMessageProvider = "grasp";

/** Whether `usage` counts nothing at all: a request that used nothing. */
const usedNothing = ({ input, output, cacheRead, cacheWrite, cost }: Usage) =>
  input + output + cacheRead + cacheWrite === 0 && cost.total === 0;

/**
 * What a reply used, as the gateway counted it (models.ts prices its cost
 * as the budgets are charged); none for core's own words, nor for a reply
 * that used nothing (refused or failed before the provider took it).
 */
const usageOf = ({
  provider,
  model,
  usage,
}: AssistantMessage): ChatReplyUsage | undefined =>
  provider === coreMessageProvider || usedNothing(usage)
    ? undefined
    : {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: usage.cost.total,
        contextWindow: contextWindowOf(model) ?? null,
      };

/** A response being written, as the person sees it so far. */
export const partialOf = (message: AssistantMessage): ChatPartial => ({
  text: textOf(message.content),
  code: codeOf(message),
  tools: toolsOf(message, chatToolPreviewChars),
  reasoning: thoughtOf(message),
});

/**
 * A stored message as the person reads it; `undefined` for a system one.
 * An answer thought for `thinkingMs`, as core kept it. It asks the person questions only in a chat whose agent is
 * offered `askQuestions` (`asking`, Grasp's own app), and proposes a
 * plan (`proposePlan`) only there too: one a chat app's
 * model calls anyway was never offered, so it shows as the failed call it
 * is, never as questions. The person's Build it shows what it built
 * (`built`). An answer names the agent that gave it (`agentId`).
 */
export const chatMessageOf = (
  id: number,
  message: Message,
  createdAt: Date,
  thinkingMs: number | null = null,
  asking = false,
  built?: ShownBuilt,
  agentId?: string
): ChatMessage | undefined => {
  const at = createdAt.toISOString();
  if (message.role === "user") {
    return {
      id,
      role: "user",
      text: textOf(message.content),
      ...(built === undefined ? {} : { built }),
      at,
    };
  }
  if (message.role === "assistant") {
    const usage = usageOf(message);
    const text = textOf(message.content);
    const reasoning = reasoningOf(message, thinkingMs);
    const asked = asking ? askedOf(message) : undefined;
    const planned = asking ? plannedOf(message) : undefined;
    return {
      id,
      role: "assistant",
      ...(agentId === undefined ? {} : { agentId }),
      text,
      code: codeOf(message),
      tools: toolsOf(message),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(asked === undefined ? {} : { asked }),
      ...(planned === undefined ? {} : { planned }),
      end: ends[message.stopReason],
      ...(message.stopReason === "error"
        ? { failure: modelFailureOf(message.errorMessage) }
        : {}),
      ...(usage === undefined ? {} : { usage }),
      at,
    };
  }
  if (message.role === "toolResult") {
    const thinking = thinkingOf(message);
    const saved = savedOf(message);
    return {
      id,
      role: "result",
      callId: message.toolCallId,
      text: textOf(message.content),
      failed: message.isError,
      at,
      ...(thinking === undefined ? {} : { thinking }),
      ...(saved === undefined ? {} : { saved }),
    };
  }
  return undefined;
};
