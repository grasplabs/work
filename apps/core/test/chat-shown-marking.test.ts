import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { agentChangeDraftSchema } from "@grasp-os/shared/agents";
import { chatPlanSchema } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { chatMessageOf, partialOf } from "../src/chat-messages.ts";
import { untrustedMarking } from "../src/untrusted-tags.ts";

// What the chat shows of a turn that read from outside: never the marking
// that tells the model what it read is data (untrusted-tags.ts), in a
// step's result, the model's thinking or the line of a tool it called.
// Shown so, as pi's messages keep it all as the model read and wrote it.
// A card the person acts on is the exception: it shows the call as the
// tool took it, the one their press acts on. Pure reads of pi's
// messages, so unit tests, as chat-tool-steps.test.ts.

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

  it("shows a tool line without a tag the model copied, holding one's beginning back as the call streams in", () => {
    const lineOf = (question: string) => [call("searchBrain", { question })];
    const kept = chatMessageOf(
      1,
      response(lineOf(`Find <${tag}>GRA-1</${tag}>`)),
      new Date(0)
    );
    // The call's input as it streams in, a tag split across two updates.
    const streamed = [
      "Find <untr",
      `Find <${tag.slice(0, 12)}`,
      `Find <${tag}>GRA`,
    ].map((question) => partialOf(response(lineOf(question))).tools[0]?.input);
    expect({
      kept: kept?.role === "assistant" ? kept.tools[0]?.input : kept,
      streamed,
    }).toStrictEqual({
      kept: { question: "Find GRA-1" },
      streamed: [
        { question: "Find " },
        { question: "Find " },
        { question: "Find GRA" },
      ],
    });
  });

  it("shows a card the person acts on as the tool took it, which is what their press acts on", () => {
    // A change to the agent Claire whose name the model wrote inside a
    // copied tag: Change it looks the agent up by the name as written
    // (`Workspace.takeAgentChange`), so the card shows that name, and the
    // person can decline it, never a Claire it would not change.
    const change = {
      agent: `<${tag}>Claire`,
      whose: "company",
      addInstructions: "Also keep the HR calendar.",
    };
    const plan = {
      parts: [
        {
          kind: "app",
          name: `<${tag}>Issues`,
          does: "Lists the issues in progress.",
        },
      ],
      who: "Me",
    };
    const shown = chatMessageOf(
      1,
      response([call("draftAgentChange", change), call("proposePlan", plan)]),
      new Date(0),
      null,
      true
    );
    expect(
      shown?.role === "assistant"
        ? { change: shown.agentChange, plan: shown.planned }
        : shown
    ).toStrictEqual({
      change: {
        callId: "call_draftAgentChange",
        ...agentChangeDraftSchema.parse(change),
      },
      plan: { callId: "call_proposePlan", ...chatPlanSchema.parse(plan) },
    });
  });
});
