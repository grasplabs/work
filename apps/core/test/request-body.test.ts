import { describe, expect, it } from "vite-plus/test";

import { boundedText } from "../src/request-body.ts";

// The unauthenticated routes' body (guest chats, interview links): the
// most exposed to a client that sends its body slowly, or never ends it.

/** What `read` settled with, or the code it refused with. */
const outcomeOf = async (read: Promise<string | undefined>) => {
  try {
    return { text: await read };
  } catch (error) {
    return {
      code:
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : String(error),
    };
  }
};

describe("an unauthenticated request's body", () => {
  it("reads a body within its size, refuses one larger, and gives up on one that stops arriving", async () => {
    const whole = new Response("hello").body;
    const larger = new Response("hello, world").body;
    const stalled = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    expect({
      whole: await outcomeOf(boundedText(whole, 8, 50)),
      larger: await outcomeOf(boundedText(larger, 8, 50)),
      stalled: await outcomeOf(boundedText(stalled, 1024, 50)),
    }).toStrictEqual({
      whole: { text: "hello" },
      larger: { text: undefined },
      stalled: { code: "request.timeout" },
    });
  });
});
