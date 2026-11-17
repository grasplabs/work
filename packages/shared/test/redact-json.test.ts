import { describe, expect, it } from "vite-plus/test";

import { redactJsonText } from "../src/redact-json.ts";
import { redact, redactedSpans } from "../src/redact.ts";

// Credentials inside text that holds JSON, redacted by its decoded string
// values wherever they stand (src/redact-json.ts, GRA-1880), never keeping
// anything `redact` would remove from the whole text. Pure logic: each case
// is an answer as a connected system might give it, every shape the two
// reviews of #2383 probed among them, and texts made at random.

/** A session ID, built from parts so the source holds no credential. */
const sid = ["s3ss", "10n", "abcdef"].join("");

/** The reviewer's line pair: a session ID on the line after a password. */
const pair = `password: hunter2\nCookie: sid=${sid}`;

/** `text` read as JSON. */
const parsed = (text: string): unknown => JSON.parse(text);

/**
 * The stretches `redact` removes from `text` (its own account of them,
 * `redactedSpans`) that stand for themselves: six characters or more,
 * found nowhere else in `text`, so finding one in an output means those
 * very characters were kept.
 */
const removedOf = (text: string): string[] =>
  redactedSpans(text)
    .map(([from, to]) => text.slice(from, to))
    .filter(
      (removed) =>
        removed.length >= 6 &&
        text.indexOf(removed) === text.lastIndexOf(removed)
    );

/**
 * Of `texts`, each stretch that `redact` removes from the whole text which
 * `redactJsonText` keeps: none when the invariant holds.
 */
const keptOfRedacted = (
  texts: readonly string[]
): { text: string; kept: string }[] =>
  texts.flatMap((text) => {
    const out = redactJsonText(text);
    return removedOf(text)
      .filter((removed) => out.includes(removed))
      .map((removed) => ({ text, kept: removed }));
  });

/** A small seeded generator, as rpc-scan.test.ts's: the same texts on every run. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state += 1;
    const value = Math.sin(state) * 10_000;
    return value - Math.floor(value);
  };
};

/** One of `items` (never empty), by `random`. */
const pickOf =
  (random: () => number) =>
  <T>(items: readonly T[]): T =>
    // SAFETY: the index is within `items`, which is never empty.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    items[Math.floor(random() * items.length)] as T;

/** Credential names `redact` knows, and words that are none. */
const names = [
  "password",
  "api_key",
  "token",
  "Cookie",
  "Authorization",
  "note",
  "id",
];

/** A text of `count` fragments of JSON and prose, stray quotes among them. */
const randomText = (random: () => number, count: number): string => {
  const pick = pickOf(random);
  const secret = (): string =>
    `S${Math.floor(random() * 1e12).toString(36)}X${Math.floor(random() * 1e9).toString(36)}`;
  const fragments: (() => string)[] = [
    () => pick(["{", "}", "[", "]", ",", ":", " ", "\n", '"', "\\", "\\n"]),
    () =>
      pick([
        'The 5" screen. ',
        'He said "see you\ntomorrow". ',
        'Order 3" bolts. ',
        "```json\n",
        "\n```",
      ]),
    () => JSON.stringify(pick(names)),
    () => `${pick(names)}${pick([": ", "=", '":"', '": "'])}`,
    () => secret(),
    () => JSON.stringify(secret()),
    () => JSON.stringify({ [pick(names)]: secret() }),
    () =>
      JSON.stringify({
        note: `${pick(names)}: ${secret()}\n${pick(names)}: ${secret()}`,
      }),
    () =>
      JSON.stringify({
        payload: JSON.stringify({ [pick(names)]: [secret(), { v: secret() }] }),
      }),
    () => `Bearer ${secret()}${secret()}`,
  ];
  return Array.from({ length: count }, () => pick(fragments)()).join("");
};

/** Documents cut at every position (each of their beginnings). */
const seeds = [
  JSON.stringify({ password: "hunter2", note: pair }),
  JSON.stringify({ payload: JSON.stringify({ note: pair }) }),
  `{"headers":{"set-cookie":["sid=${sid}; HttpOnly"]},"token":{"value":"abc123def"}}`,
  `The 5" screen. {"password":"S3CR3T"} and api_key="K3YK3Y"`,
];

/** A secret the probed shapes hold. */
const S = "hunter2SECRET";

/** Every shape the two reviews of #2383 probed. */
const probed = [
  `The 5" screen. {"password":"${S}"}`,
  `He said "hi. {"access_token":"${S}","x":1}`,
  `Order 3" bolts. api_key="${S}" for the portal`,
  `He said "see you\ntomorrow". Then password: "${S}" ok`,
  `{"note":"a\nb","password":"${S}"}`,
  `{"password":"${S}`,
  `{"password":"\\u0068unter2SECRET"}`,
  `{"note":"\\ud83d\\ude00 password: ${S}"}`,
  `{"note":"a\\\\","password":"${S}"}`,
  `{"note":"say \\"password: ${S}\\" ok"}`,
  `{"password"\u000B:\u000C"${S}"}`,
  `{"password"\u00A0:\u00A0"${S}"}`,
  `{"PassWord":"${S}"}`,
  `{"client-secret":"${S}"}`,
  `{"X-Api-Key":"${S}"}`,
  `{"pass\\u0077ord":"${S}"}`,
  `{"secret":{"a":"}","b":"${S}"},"ok":"keep"}`,
  JSON.stringify({
    a: JSON.stringify({
      b: JSON.stringify({ c: JSON.stringify({ password: S }) }),
    }),
  }),
  JSON.stringify({
    a: JSON.stringify({ b: JSON.stringify({ c: `x\nCookie: sid=${S}` }) }),
  }),
  `{"note":"line1\npassword: ${S}"}`,
  `{"password":"a\nb${S}"}`,
  `{'password':'${S}'}`,
  `{"pin":1,"password":12345678}`,
  `{"password":${S}}`,
  `{"token": [ "${S}" , {"x":"${S}"} ] , "k":"v"}`,
  `password: "${S}`,
  `{"password"\n\n:\n"${S}"}`,
  `{"secret":{"a":"${S}"`,
  `{"v":"Bearer\\u0020abcdefghijklmnopqrstuvwx"}`,
  `{"u":"https:\\/\\/x.test\\/a?sig=${S}"}`,
  `Subject: pipes\n\nWe need the 12" pipes.\nWifi password: "${S}"\nThanks`,
  `| size | 5" |\n|---|---|\n\nsecret = "${S}"`,
  `a "b\nc" d "password": "${S}"`,
  `{"note":"token=abc\\u0020def"}`,
];

describe("redacting credentials inside JSON text", () => {
  it("never keeps what redact removes from the whole text: random texts, every cut of a few documents, and every probed shape", () => {
    const random = seeded(1845);
    const texts = [
      ...Array.from({ length: 1500 }, () =>
        randomText(random, 3 + Math.floor(random() * 20))
      ),
      ...seeds.flatMap((seed) =>
        Array.from({ length: seed.length + 1 }, (_, end) => seed.slice(0, end))
      ),
      ...probed,
    ];

    // The account is `redact`'s own: what it reports is gone from `redact`'s output too.
    const misreported = texts.flatMap((text) =>
      removedOf(text).filter((removed) => redact(text).includes(removed))
    );

    expect({
      kept: keptOfRedacted(texts),
      misreported,
    }).toStrictEqual({ kept: [], misreported: [] });
  });

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
    }).toStrictEqual({
      leaks: [],
      // `redact` over the whole text takes `hunter2\nCookie:` as one value.
      document: { note: "password: [redacted] [redacted]" },
    });
  });

  it("removes whatever a credential's name holds, a list, an object, a number or a string cut off", () => {
    const answers = [
      ...[
        { headers: { "set-cookie": [`sid=${sid}; HttpOnly`] } },
        { password: ["hunter2"] },
        { token: { value: "abcdef123" } },
        { Authorization: ["Bearer abc123"] },
        { "password ": "hunter2" },
        { password: 1234, secret: true },
      ].map((answer) => JSON.stringify(answer)),
      '{"password":"hunter2',
      '{"note":"x","token":"abc',
    ];

    expect(answers.map((answer) => redactJsonText(answer))).toStrictEqual([
      '{"headers":{"set-cookie":[redacted]}}',
      '{"password":[redacted]}',
      '{"token":[redacted]}',
      '{"Authorization":[redacted]}',
      '{"password ":"[redacted]"}',
      '{"password":[redacted],"secret":[redacted]',
      '{"password":"[redacted]',
      '{"note":"x","token":"[redacted]',
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
      '{"https://x.test/?sig=[redacted]":"v"}',
    ]);
  });

  it("gives back a text with nothing to redact byte for byte, numbers as written and stray quotes too, and rewrites only what it removes", () => {
    const pick = pickOf(seeded(2383));
    const benign = Array.from({ length: 500 }, () =>
      Array.from({ length: 12 }, () =>
        pick([
          '{"id":12345678901234567890,"amount":1.10,"e":1e3}',
          'The 5" screen',
          '"note"',
          ":",
          ",",
          "[",
          "]",
          '"see you\nthen"',
          "\\u0020",
          "1.10",
        ])
      ).join("")
    );

    expect({
      changed: benign.filter((text) => redactJsonText(text) !== text),
      withSecret: redactJsonText(
        '{"id":12345678901234567890, "amount":1.10, "password":"x"}'
      ),
    }).toStrictEqual({
      changed: [],
      withSecret:
        '{"id":12345678901234567890, "amount":1.10, "password":"[redacted]"}',
    });
  });

  it("redacts a megabyte in linear time, however deep it nests or however many quotes it holds", () => {
    const member = { note: pair, token: "t" };
    const answers = [
      JSON.stringify(
        Array.from({ length: 20_000 }, (_, index) => ({ ...member, index }))
      ),
      `${'{"a":'.repeat(100_000)}1${"}".repeat(100_000)}`,
      `${"[".repeat(500_000)}${"]".repeat(500_000)}`,
      `5" `.repeat(330_000),
      JSON.stringify(Array.from({ length: 250_000 }, () => "a")),
    ];
    const took = answers.map((answer) => {
      const started = performance.now();
      redactJsonText(answer);
      return performance.now() - started;
    });

    // About a megabyte each: a quadratic scan takes seconds.
    expect(took.every((ms) => ms < 3000)).toBeTruthy();
  });
});
