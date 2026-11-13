import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { chatToolPreviewChars } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { chatMessageOf, partialOf } from "../src/chat-messages.ts";

// A response's tool calls as the thread shows them, beside its code steps:
// where each stands among the code steps, and, while the response is
// written, its texts cut short. Pure reads of pi's messages, so unit tests;
// that a chat keeps and shows them is tested through a chat
// (agent-builds.test.ts).

/** A response that called `calls`, in order: code steps and tool calls. */
const response = (
  ...calls: Pick<ToolCall, "name" | "arguments">[]
): AssistantMessage => ({
  role: "assistant",
  content: calls.map((call, at) => ({
    type: "toolCall" as const,
    id: `call_${at}`,
    ...call,
  })),
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

const code = (source: string) => ({
  name: "executeCode",
  arguments: { code: source },
});

describe("a response's tool calls", () => {
  it("stand where the response made them among its code steps", () => {
    const shown = chatMessageOf(
      1,
      response(
        { name: "readFile", arguments: { app: "a", path: "app.ts" } },
        code("return 1;"),
        { name: "readApi", arguments: { names: ["build"] } },
        { name: "writeFile", arguments: { app: "a", files: { "x.md": "x" } } },
        code("return 2;"),
        code("return 3;"),
        { name: "searchBrain", arguments: { question: "expenses" } }
      ),
      new Date(0)
    );

    expect(
      shown?.role === "assistant"
        ? {
            code: shown.code.map(({ callId }) => callId),
            tools: shown.tools.map(({ tool, codeBefore }) => [
              tool,
              codeBefore,
            ]),
          }
        : shown
    ).toStrictEqual({
      code: ["call_1", "call_4", "call_5"],
      // Reading an API's declaration is no step of either kind.
      tools: [
        ["readFile", 0],
        ["writeFile", 1],
        ["searchBrain", 3],
      ],
    });
  });

  it("show their texts cut short while the response is written, and whole once kept", () => {
    const long = "x".repeat(chatToolPreviewChars + 50);
    const written = response({
      name: "writeFile",
      arguments: { app: "a", files: { "src/routes/index.tsx": long } },
    });

    const kept = chatMessageOf(1, written, new Date(0));
    expect({
      partial: partialOf(written).tools[0]?.input,
      kept: kept?.role === "assistant" ? kept.tools[0]?.input : kept,
    }).toStrictEqual({
      partial: {
        app: "a",
        files: {
          "src/routes/index.tsx": `${"x".repeat(chatToolPreviewChars)}…`,
        },
      },
      kept: { app: "a", files: { "src/routes/index.tsx": long } },
    });
  });
});
