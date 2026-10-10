import { describe, expect, it } from "vite-plus/test";

import { bodyBytes, outputCapOf, unboundedBy } from "../src/model-requests.ts";

// What the model ledger bounds a provider request by, read from the body
// the gateway is about to send: pure parsing, tested on its own.

const body = (fields: object): string =>
  JSON.stringify({ model: "m", stream: true, ...fields });

const text = { role: "user", content: [{ type: "text", text: "Hi" }] };

/** A body whose last message holds `part`. */
const holding = (part: object): string =>
  body({ messages: [text, { role: "user", content: [part] }] });

describe("model requests", () => {
  it("count a body's bytes as sent, multibyte characters included", () => {
    expect([
      bodyBytes(body({})),
      bodyBytes("é"),
      bodyBytes(new Uint8Array(7)),
      bodyBytes(null),
    ]).toStrictEqual([body({}).length, 2, 7, undefined]);
  });

  it("take the largest answer cap a body sets, whichever field sets it", () => {
    expect(
      [
        body({ max_tokens: 100 }),
        body({ max_output_tokens: 200 }),
        body({ max_completion_tokens: 300 }),
        body({ max_tokens: 100, max_completion_tokens: 900 }),
        body({ max_output_tokens: 900, max_tokens: 100 }),
        body({}),
        "not JSON",
      ].map(outputCapOf)
    ).toStrictEqual([100, 200, 300, 900, 900, undefined, undefined]);
  });

  it("refuse what its bytes can't bound or its prices can't price, wherever it sits", () => {
    expect(
      [
        body({ messages: [text] }),
        holding({ type: "image", source: { type: "base64", data: "x" } }),
        holding({ type: "image_url", image_url: { url: "data:x" } }),
        holding({ type: "input_image", image_url: "data:x" }),
        holding({ type: "document", source: { type: "base64", data: "x" } }),
        holding({ type: "file", file: { file_id: "f" } }),
        holding({ type: "input_file", file_id: "f" }),
        body({ previous_response_id: "resp_1" }),
        body({ service_tier: "priority" }),
        holding({
          type: "text",
          text: "Hi",
          cache_control: { type: "ephemeral", ttl: "1h" },
        }),
        holding({
          type: "text",
          text: "Hi",
          cache_control: { type: "ephemeral" },
        }),
        // A tool's schema may name such types: it isn't content.
        body({
          messages: [text],
          tools: [{ name: "t", input_schema: { type: "file" } }],
        }),
        "not JSON",
      ].map(unboundedBy)
    ).toStrictEqual([
      undefined,
      "image",
      "image_url",
      "input_image",
      "document",
      "file",
      "input_file",
      "previous_response_id",
      "service_tier",
      "cache_ttl",
      undefined,
      undefined,
      "body",
    ]);
  });
});
