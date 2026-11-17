import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { redactJsonText } from "../src/redact-json.ts";
import { redact } from "../src/redact.ts";

// Credentials inside text that holds JSON, redacted by its decoded string
// values wherever they stand (src/redact-json.ts, GRA-1880). Pure logic:
// each case is an answer as a connected system might give it, the shapes
// the review of #2383 probed among them.

/** `text` read as JSON. */
const parsed = (text: string): unknown => JSON.parse(text);

/** A session ID, built from parts so the source holds no credential. */
const sid = ["s3ss", "10n", "abcdef"].join("");

/** The reviewer's line pair: a session ID on the line after a password. */
const pair = `password: hunter2\nCookie: sid=${sid}`;

/** What `pair` becomes. */
const pairRedacted = "password: [redacted]\nCookie: [redacted]";

describe("redacting credentials inside JSON text", () => {
  it("redacts a credential on the line after another inside a string, wherever the JSON stands", () => {
    const member = JSON.stringify({ note: pair });
    const shapes = {
      document: member,
      stringAlone: JSON.stringify(pair),
      jsonInAString: JSON.stringify({ payload: member }),
      thenProse: `${member}\nmore`,
      oneDocumentALine: `${member}\n{"a":1}`,
      codeFence: `\`\`\`json\n${member}\n\`\`\``,
      cutOff: member.slice(0, -1),
      // Text blocks as connect joins them: with a newline.
      blocks: `${member}\n${JSON.stringify({ other: pair })}`,
    };

    const leaks = Object.entries(shapes).flatMap(([shape, text]) => {
      const redacted = redactJsonText(text);
      return redacted.includes(sid) || redacted.includes("hunter2")
        ? [shape]
        : [];
    });

    expect({
      leaks,
      document: parsed(redactJsonText(shapes.document)),
      jsonInAString: parsed(
        z
          .object({ payload: z.string() })
          .parse(parsed(redactJsonText(shapes.jsonInAString))).payload
      ),
    }).toStrictEqual({
      leaks: [],
      document: { note: pairRedacted },
      jsonInAString: { note: pairRedacted },
    });
  });

  it("replaces whatever a credential's name holds, a list, an object or a number, and keeps a null", () => {
    const answers = [
      { headers: { "set-cookie": [`sid=${sid}; HttpOnly`] } },
      { password: ["hunter2"] },
      { token: { value: "abcdef123" } },
      { Authorization: ["Bearer abc123"] },
      { "password ": "hunter2" },
      { password: 1234, secret: true, api_key: null },
    ].map((answer) => JSON.stringify(answer));

    expect(
      answers.map((answer) => parsed(redactJsonText(answer)))
    ).toStrictEqual([
      { headers: { "set-cookie": "[redacted]" } },
      { password: "[redacted]" },
      { token: "[redacted]" },
      { Authorization: "[redacted]" },
      { "password ": "[redacted]" },
      { password: "[redacted]", secret: "[redacted]", api_key: null },
    ]);
  });

  it("reads a name as JSON writes it: escaped, and each of the same name", () => {
    expect([
      // `password` with its `w` written as an escape: built from parts.
      redactJsonText(['{"pass', "\\u0077", 'ord":"hunter2"}'].join("")),
      redactJsonText('{"password":"a","password":"b"}'),
      redactJsonText('{"__proto__":{"password":"x"}}'),
      redactJsonText(JSON.stringify({ "https://x.test/?sig=abc": "v" })),
    ]).toStrictEqual([
      ['{"pass', "\\u0077", 'ord":"[redacted]"}'].join(""),
      '{"password":"[redacted]","password":"[redacted]"}',
      '{"__proto__":{"password":"[redacted]"}}',
      '{"https://x.test/?sig=%5Bredacted%5D":"v"}',
    ]);
  });

  it("gives back a text with nothing to redact byte for byte, numbers as written, and rewrites only what it redacts", () => {
    const records = '{"id":12345678901234567890,"amount":1.10,"e":1e3}';
    const withSecret =
      '{"id":12345678901234567890, "amount":1.10, "password":"x"}';

    expect({
      records: redactJsonText(records),
      number: redactJsonText("1.10"),
      withSecret: redactJsonText(withSecret),
    }).toStrictEqual({
      records,
      number: "1.10",
      withSecret:
        '{"id":12345678901234567890, "amount":1.10, "password":"[redacted]"}',
    });
  });

  it("redacts prose and text that is not JSON as redact does, a quoted value after a credential's name too", () => {
    const texts = [
      `password: hunter2 and Cookie: sid=${sid}`,
      "Nothing secret here.",
      "",
      "[".repeat(200_000),
    ];

    expect({
      same: texts.map((text) => redactJsonText(text) === redact(text)),
      quoted: redactJsonText('The password: "hunter2", then more.'),
    }).toStrictEqual({
      same: [true, true, true, true],
      quoted: 'The password: "[redacted]", then more.',
    });
  });

  it("redacts a megabyte of JSON in linear time, however deep it nests", () => {
    const member = { note: pair, token: "t" };
    const answers = [
      JSON.stringify(
        Array.from({ length: 20_000 }, (_, index) => ({ ...member, index }))
      ),
      `${'{"a":'.repeat(100_000)}1${"}".repeat(100_000)}`,
      `${"[".repeat(500_000)}${"]".repeat(500_000)}`,
    ];
    const took = answers.map((answer) => {
      const started = performance.now();
      redactJsonText(answer);
      return performance.now() - started;
    });

    // About a megabyte each: a quadratic walk takes seconds.
    expect(took.every((ms) => ms < 2000)).toBeTruthy();
  });
});
