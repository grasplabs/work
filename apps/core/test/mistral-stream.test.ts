import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it } from "vite-plus/test";

import { openAiLine, withOpenAiContent } from "../src/mistral-stream.ts";
import { parseModelRef } from "../src/model-catalog.ts";

/** A Mistral reasoning answer's stream: its thinking, then its text, as chunk lists. */
const reasoned = [
  {
    content: [
      { type: "thinking", thinking: [{ type: "text", text: "They said " }] },
    ],
  },
  {
    content: [
      { type: "thinking", thinking: [{ type: "text", text: "hello." }] },
    ],
  },
  { content: [{ type: "text", text: "Hi, " }] },
  { content: "there." },
]
  .map(
    (delta, at) =>
      `data: ${JSON.stringify({ id: "c", model: "mistral-small-latest", choices: [{ index: 0, delta, finish_reason: at === 3 ? "stop" : null }] })}\n\n`
  )
  .join("");

describe("Mistral's streamed content", () => {
  it("puts a delta's chunk list in OpenAI's words", () => {
    const line = openAiLine(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              content: [
                { type: "thinking", thinking: [{ type: "text", text: "Hm" }] },
                { type: "text", text: "Yes" },
              ],
            },
          },
        ],
      })}`
    );
    expect(JSON.parse(line.slice("data: ".length))).toStrictEqual({
      choices: [{ delta: { content: "Yes", reasoning_content: "Hm" } }],
    });
  });

  it("leaves a string delta and other lines as they are", () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "Yes" } }] })}`;
    expect(openAiLine(line)).toBe(line);
    expect(openAiLine("data: [DONE]")).toBe("data: [DONE]");
  });

  it("gives pi the answer's text alone, its thinking apart", async () => {
    const model = parseModelRef("mistral/mistral-small-latest");
    if (model === undefined) {
      throw new Error("No Mistral Small in the catalog");
    }
    // oxlint-disable-next-line require-await -- a fetch, whose answer is at hand
    const fetch = withOpenAiContent(async () => {
      // A few bytes at a time, cutting lines apart.
      const bytes = new TextEncoder().encode(`${reasoned}data: [DONE]\n\n`);
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (let at = 0; at < bytes.length; at += 7) {
            controller.enqueue(bytes.slice(at, at + 7));
          }
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const answer = await streamSimple(
      { ...model.catalog, api: "openai-completions" },
      normalizeContext({
        messages: [{ role: "user", content: "Hello.", timestamp: 0 }],
      }),
      { apiKey: "key", fetch, reasoning: "high", maxRetries: 0 }
    ).result();
    expect(answer.stopReason).toBe("stop");
    expect(answer.content).toStrictEqual([
      expect.objectContaining({
        type: "thinking",
        thinking: "They said hello.",
      }),
      expect.objectContaining({ type: "text", text: "Hi, there." }),
    ]);
  });
});
