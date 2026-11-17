import { describe, expect, it } from "vite-plus/test";

import { redactJsonText } from "../src/redact-json.ts";
import { redact } from "../src/redact.ts";

// Credentials inside JSON text, redacted by its decoded values
// (src/redact-json.ts, GRA-1880). Pure logic: each case is an answer as
// a connected system might give it.

/** A session ID, built from parts so the source holds no credential. */
const sid = ["s3ss", "10n", "abcdef"].join("");

describe("redacting credentials inside JSON text", () => {
  it("redacts a credential on the line after another, inside a string value", () => {
    const answer = JSON.stringify({
      body: `password: hunter2\nCookie: sid=${sid}\nSee you then.`,
    });

    const kept: unknown = JSON.parse(redactJsonText(answer));

    expect(kept).toStrictEqual({
      body: "password: [redacted]\nCookie: [redacted]\nSee you then.",
    });
  });

  it("writes back JSON of the same shape, with every credential member's value replaced, a number too", () => {
    const answer = JSON.stringify({
      deal: { id: 7, name: "Renewal", won: true, owner: null },
      auth: { access_token: "abc.def", password: 1234, retries: 3 },
      notes: ["Call back", `token=${sid}`],
    });

    expect(JSON.parse(redactJsonText(answer))).toStrictEqual({
      deal: { id: 7, name: "Renewal", won: true, owner: null },
      auth: { access_token: "[redacted]", password: "[redacted]", retries: 3 },
      notes: ["Call back", "token=[redacted]"],
    });
  });

  it("redacts text that is not JSON exactly as before", () => {
    const texts = [
      `password: hunter2 and Cookie: sid=${sid}`,
      "Nothing secret here.",
      '{"broken": ',
      "",
    ];

    expect(texts.map((text) => redactJsonText(text))).toStrictEqual(
      texts.map((text) => redact(text))
    );
  });

  it("redacts a megabyte of JSON in linear time", () => {
    const member = { note: `password: x\nCookie: sid=${sid}`, token: "t" };
    const answer = JSON.stringify(
      Array.from({ length: 20_000 }, (_, index) => ({ ...member, index }))
    );
    const started = performance.now();
    redactJsonText(answer);
    const took = performance.now() - started;

    // About 1.3 MB: a quadratic walk takes seconds.
    expect({
      size: answer.length > 1_000_000,
      fast: took < 2000,
    }).toStrictEqual({ size: true, fast: true });
  });
});
