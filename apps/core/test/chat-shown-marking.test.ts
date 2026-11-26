import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { chatMessageOf, partialOf } from "../src/chat-messages.ts";
import { untrustedMarking } from "../src/untrusted-tags.ts";

// What the chat shows of a turn that read from outside: never the marking
// that tells the model what it read is data (untrusted-tags.ts), in a
// step's result, the model's thinking or the calls it made. Shown so, as
// pi's messages keep it all as the model read and wrote it. Pure reads of
// pi's messages, so unit tests, as chat-tool-steps.test.ts.

const marking = untrustedMarking("connection c1 (linear.issues)");
const tag = marking.close.slice("\n</".length, -">".length);

/** A response of `content`, as pi keeps it. */
const response = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 0,
});

/** A call of `name` with `input`. */
const call = (name: string, input: ToolCall["arguments"]): ToolCall => ({
  type: "toolCall",
  id: `call_${name}`,
  name,
  arguments: input,
});

describe("what the chat shows of a turn that read from outside", () => {
  it("shows a code step's result without the marking, and the text it marked", () => {
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "executeCode",
      content: [
        {
          type: "text",
          text: `${marking.open}Returned:\n["GRA-1","GRA-2"]${marking.close}`,
        },
      ],
      isError: false,
      timestamp: 0,
    };
    const shown = chatMessageOf(1, result, new Date(0));
    expect(shown?.role === "result" ? shown.text : shown).toBe(
      'Returned:\n["GRA-1","GRA-2"]'
    );
  });

  it("shows the model's thinking without a tag it copied, holding one's beginning back as it streams", () => {
    const thinking = (text: string) =>
      response([{ type: "thinking", thinking: text }]);
    const kept = chatMessageOf(
      1,
      thinking(`The run said <${tag}> two issues </${tag}>.`),
      new Date(0)
    );
    expect({
      kept: kept?.role === "assistant" ? kept.reasoning?.text : kept,
      streaming: partialOf(thinking("The run said <untrus")).reasoning,
    }).toStrictEqual({
      kept: "The run said  two issues .",
      streaming: "The run said ",
    });
  });

  it("shows the questions, plan and tool calls the model made without a tag it copied", () => {
    const shown = chatMessageOf(
      1,
      response([
        call("searchBrain", { question: `<${tag}>GRA-1` }),
        call("askQuestions", {
          questions: [
            {
              kind: "choice",
              question: `Which of <${tag}>these</${tag}>?`,
              options: [{ label: "GRA-1" }, { label: "GRA-2" }],
            },
          ],
        }),
        call("proposePlan", {
          parts: [
            {
              kind: "app",
              name: `<${tag}>Issues`,
              does: "Lists the issues in progress.",
            },
          ],
          who: "Me",
        }),
      ]),
      new Date(0),
      null,
      true
    );
    expect(
      shown?.role === "assistant"
        ? {
            tool: shown.tools[0]?.input,
            question: shown.asked?.questions[0]?.question,
            plan: shown.planned?.parts[0]?.name,
          }
        : shown
    ).toStrictEqual({
      tool: { question: "GRA-1" },
      question: "Which of these?",
      plan: "Issues",
    });
  });
});
