import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import {
  agentChangeDraftSchema,
  agentDraftSchema,
} from "@grasp-os/shared/agents";
import type { AgentChangeDrafted, AgentDrafted } from "@grasp-os/shared/agents";
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
import { withoutUntrustedMarking } from "./untrusted-tags.ts";

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

/** `value` with each text in it as a person is shown it, at any depth. */
const shownTexts = (value: unknown): unknown => {
  if (typeof value === "string") {
    return withoutUntrustedMarking(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => shownTexts(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shownTexts(item)])
    );
  }
  return value;
};

/**
 * A call's input as a person is shown it, never as it is kept: without the
 * tags that mark what was read from outside, should the model copy one.
 */
const shownInput = (part: ToolCall): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(part.arguments).map(([key, value]) => [
      key,
      shownTexts(value),
    ])
  );

/**
 * A call's input as `schema` took it, as a person is shown it: none when
 * the tool refused it as the model wrote it; as written when what is shown
 * would no longer pass (a text that was nothing but a tag).
 */
const takenAs = <T>(schema: z.ZodType<T>, part: ToolCall): T | undefined => {
  const taken = schema.safeParse(part.arguments);
  if (!taken.success) {
    return undefined;
  }
  const shown = schema.safeParse(shownInput(part));
  return shown.success ? shown.data : taken.data;
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
    const shown = shownInput(part);
    const input: Record<string, unknown> =
      chars === undefined
        ? shown
        : Object.fromEntries(
            Object.entries(shown).map(([key, value]) => [
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
      const ask = takenAs(chatAskSchema, part);
      if (ask !== undefined) {
        return { callId: part.id, ...ask };
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
      const plan = takenAs(chatPlanSchema, part);
      if (plan !== undefined) {
        return { callId: part.id, ...plan };
      }
    }
  }
  return undefined;
};

/**
 * The agent a response drafted (`draftAgent`), as the tool took it: its
 * first call the schema takes; none when it drafted none.
 */
const draftedOf = (message: AssistantMessage): AgentDrafted | undefined => {
  for (const part of message.content) {
    if (part.type === "toolCall" && part.name === "draftAgent") {
      const draft = takenAs(agentDraftSchema, part);
      if (draft !== undefined) {
        return { callId: part.id, ...draft };
      }
    }
  }
  return undefined;
};

/** The change to an agent a response drafted (`draftAgentChange`), as the tool took it. */
const changeDraftedOf = (
  message: AssistantMessage
): AgentChangeDrafted | undefined => {
  for (const part of message.content) {
    if (part.type === "toolCall" && part.name === "draftAgentChange") {
      const change = takenAs(agentChangeDraftSchema, part);
      if (change !== undefined) {
        return { callId: part.id, ...change };
      }
    }
  }
  return undefined;
};

/**
 * What a response ended on for the person to answer: questions, a plan,
 * a drafted agent or a change to one; each only where it was offered.
 */
const cardsOf = (
  message: AssistantMessage
): Pick<
  Extract<ChatMessage, { role: "assistant" }>,
  "asked" | "planned" | "agentDraft" | "agentChange"
> => {
  const asked = askedOf(message);
  const planned = plannedOf(message);
  const agentDraft = draftedOf(message);
  const agentChange = changeDraftedOf(message);
  return {
    ...(asked === undefined ? {} : { asked }),
    ...(planned === undefined ? {} : { planned }),
    ...(agentDraft === undefined ? {} : { agentDraft }),
    ...(agentChange === undefined ? {} : { agentChange }),
  };
};

/**
 * What a response thought, as far as it has streamed in (`more`): each
 * thinking part the provider showed, joined, without the marking of what
 * was read from outside should the model copy it (kept as it came: the
 * provider signs it). A redacted part holds only pi's own placeholder,
 * never the model's words, so it shows nothing.
 */
const thoughtOf = (message: AssistantMessage, more = false): string =>
  withoutUntrustedMarking(
    message.content
      .flatMap((part) =>
        part.type === "thinking" &&
        part.redacted !== true &&
        part.thinking !== ""
          ? [part.thinking]
          : []
      )
      .join("\n\n"),
    more
  );

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
  reasoning: thoughtOf(message, true),
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
    return {
      id,
      role: "assistant",
      ...(agentId === undefined ? {} : { agentId }),
      text,
      code: codeOf(message),
      tools: toolsOf(message),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(asking ? cardsOf(message) : {}),
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
      text: withoutUntrustedMarking(textOf(message.content)),
      failed: message.isError,
      at,
      ...(thinking === undefined ? {} : { thinking }),
      ...(saved === undefined ? {} : { saved }),
    };
  }
  return undefined;
};
