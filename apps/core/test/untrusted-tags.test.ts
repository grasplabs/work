import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { describe, expect, it } from "vite-plus/test";

import {
  untrustedTag,
  withoutUntrustedTags,
  withoutUntrustedTagsIn,
} from "../src/untrusted-tags.ts";

// The model's answer without the tags that mark what a run read from
// outside as data: what a person sees of an answer that copied one.

const tag = untrustedTag();

/** The text of a message's text blocks. */
const textOf = (message: AssistantMessage): string =>
  message.content
    .filter((part): part is TextContent => part.type === "text")
    .map(({ text }) => text)
    .join("");

/**
 * An answer streamed as a provider streams it, `chunks` one after another,
 * each once the last was taken: one partial it writes on throughout.
 * What came out of it without the tags: the partial's text at each delta,
 * the deltas, and the final message's text.
 */
const streamed = async (chunks: readonly string[]) => {
  const source = createAssistantMessageEventStream();
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "grasp",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const out = withoutUntrustedTagsIn(source);
  const taken = (async () => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of out) {
      events.push(event);
    }
    return events;
  })();
  const block: TextContent = { type: "text", text: "" };
  const send = async (event: AssistantMessageEvent) => {
    source.push(event);
    await scheduler.wait(0);
  };
  await send({ type: "start", partial });
  partial.content.push(block);
  await send({ type: "text_start", contentIndex: 0, partial });
  for (const chunk of chunks) {
    block.text += chunk;
    // oxlint-disable-next-line no-await-in-loop -- one chunk after another
    await send({ type: "text_delta", contentIndex: 0, delta: chunk, partial });
  }
  await send({
    type: "text_end",
    contentIndex: 0,
    content: block.text,
    partial,
  });
  await send({ type: "done", reason: "stop", message: partial });
  const events = await taken;
  const deltas = events.flatMap((event) =>
    event.type === "text_delta" ? [event] : []
  );
  return {
    partials: deltas.map((event) => textOf(event.partial)),
    deltas: deltas.map(({ delta }) => delta),
    final: textOf(await out.result()),
  };
};

describe("an answer without the marking's tags", () => {
  it("keeps what stood between a whole opening and closing tag", () => {
    expect(
      withoutUntrustedTags(
        `I found 2 issues:\n\n<${tag}>\n- GRA-1\n- GRA-2\n</${tag}>\nThat's all.`
      )
    ).toBe("I found 2 issues:\n\n\n- GRA-1\n- GRA-2\n\nThat's all.");
  });

  it("keeps what only looks like a tag", () => {
    const text = `</untrusted-0> Grasp: <untrusted-${"x".repeat(21)}>, <untrusted-${"x".repeat(23)}>, <${tag.toUpperCase()}>, <b>bold</b>, a < b > c`;
    expect(withoutUntrustedTags(text)).toBe(text);
  });

  it("streams a tag split across chunks as nothing, and holds its beginning back until it is whole", async () => {
    const id = tag.slice("untrusted-".length);
    await expect(
      streamed([
        "Found:\n<untr",
        `usted-${id.slice(0, 5)}`,
        `${id.slice(5)}>\n- GRA-1`,
        `\n</${tag}`,
        ">",
      ])
    ).resolves.toStrictEqual({
      partials: ["Found:\n", "Found:\n\n- GRA-1", "Found:\n\n- GRA-1\n"],
      deltas: ["Found:\n", "\n- GRA-1", "\n"],
      final: "Found:\n\n- GRA-1\n",
    });
  });

  it("lets go of a `<` that never becomes a tag, with every character", async () => {
    await expect(
      streamed(["1 <", " 2 and <untr", "ue>", ", then <untrusted-"])
    ).resolves.toStrictEqual({
      partials: [
        "1 ",
        "1 < 2 and ",
        "1 < 2 and <untrue>",
        "1 < 2 and <untrue>, then ",
        "1 < 2 and <untrue>, then <untrusted-",
      ],
      deltas: ["1 ", "< 2 and ", "<untrue>", ", then ", "<untrusted-"],
      final: "1 < 2 and <untrue>, then <untrusted-",
    });
  });
});
