/**
 * What the e2e stack's fake providers answer (e2e/model-fake.ts): for each
 * script, the agent's replies in a chat its person opened with `opener`,
 * one per turn of the agent's, in order. The fake keeps no state: each
 * request carries its chat so far, so the turn is the replies the agent
 * already gave in it, and parallel tests never share one.
 */
import { z } from "zod";

import type { Answer } from "../apps/core/test/provider-streams.ts";

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
  /**
   * A new workflow drawn in its chat: the person answers the page's own
   * first question, which business process it is for, and Grasp asks on.
   */
  drawsWorkflow: {
    opener: "Which business process is this workflow for?",
    replies: [
      says(
        "Purchase-to-Pay, then. Where does a supplier's invoice come in, and who looks at it first?"
      ),
    ],
  },
} as const satisfies Record<string, ModelScript>;

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

/**
 * A provider request's messages (chat completions and Anthropic's messages
 * alike), and the tools it offers.
 */
const requestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
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
 * The scripted answer to a provider request's `body`: the next of the
 * replies of the script its chat opened with. Only an agent's turn has
 * one, as only it offers tools: anything else the stack asks a model for,
 * such as a chat's title, has none, nor has a turn past a script's end, so
 * the fake refuses it as it refuses every other request.
 */
export const scriptedAnswer = (body: unknown): Answer | undefined => {
  const request = requestSchema.safeParse(body);
  if (!request.success) {
    return undefined;
  }
  const { messages } = request.data;
  const opened = textOf(messages.find(({ role }) => role === "user")?.content);
  const script = Object.values(modelScripts).find(({ opener }) =>
    opened.includes(opener)
  );
  const turn = messages.filter(({ role }) => role === "assistant").length;
  return script?.replies[turn];
};
