import { z } from "zod";

import type { Answer, GatewayReply } from "./provider-replies.ts";

/**
 * What the e2e stack's scripted model answers (model-worker.ts): for each
 * script, the agent's replies to a chat its person opened with `opener`,
 * one per turn of the agent's, in order. The model has no state of its
 * own: each request carries its chat so far, so the turn is the replies
 * the agent already gave in it, and parallel tests never share one.
 */
export interface ModelScript {
  /** What the person's first message in the chat says, as they type it. */
  opener: string;
  /** The agent's replies, a turn of its each. */
  replies: readonly Answer[];
}

/** The agent says `text`, and is done. */
const says = (text: string): Answer => ({
  text,
  inputTokens: 200,
  outputTokens: 20,
});

export const modelScripts = {
  /** A chat turn, end to end: the person asks, the agent answers. */
  answers: {
    opener: "What should the weekly sales report cover?",
    replies: [
      says("Revenue by region, the deals that closed, and the pipeline."),
    ],
  },
} as const satisfies Record<string, ModelScript>;

/**
 * The model's refusal of a request no script answers, as a provider
 * refuses one it won't take: at once, never tried again.
 */
const unscripted: GatewayReply = {
  status: 400,
  body: {
    error: {
      type: "invalid_request_error",
      message: "The e2e stack's scripted model has no reply for this request",
    },
  },
};

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

/**
 * A provider request's messages (chat completions and Anthropic's messages
 * alike), and the tools it offers.
 */
const requestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.unknown(),
    })
  ),
  tools: z.array(z.unknown()).min(1),
});

/** A message's text, whether a string or a list of parts. */
const textOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part: unknown) => {
      const text = textPartSchema.safeParse(part);
      return text.success ? [text.data.text] : [];
    })
    .join("");
};

/**
 * The scripted model's reply to a provider request's `body`: the next of
 * the replies of the script its chat opened with. Only an agent's turn has
 * one, as only it offers tools: anything else the stack asks a model for,
 * such as a chat's title or what goes to memory, is refused, as is a
 * turn past a script's end.
 */
export const scriptedReply = (body: unknown): GatewayReply => {
  const request = requestSchema.safeParse(body);
  if (!request.success) {
    return unscripted;
  }
  const { messages } = request.data;
  const opened = textOf(messages.find(({ role }) => role === "user")?.content);
  const script = Object.values(modelScripts).find(({ opener }) =>
    opened.includes(opener)
  );
  const turn = messages.filter(({ role }) => role === "assistant").length;
  return script?.replies[turn] ?? unscripted;
};
