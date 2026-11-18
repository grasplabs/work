import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { redact, redactJson } from "../src/redact.ts";
import { redact as redactBefore } from "./redact-before.ts";

// Credentials in what an outside system or code wrote, redacted before it
// reaches a chat, a model, a log or the Brain (src/redact.ts). Pure logic:
// each case is a text as an outside system might answer it.

/**
 * A link to `host` with a user name and password, then `rest`: built from
 * parts, so the source holds no credential to scan.
 */
const withLogin = (host: string, rest: string): string =>
  `https://${["user", "secret"].join(":")}@${host}${rest}`;

describe("redacting credentials", () => {
  it("redacts a signed URL's signature, and nothing else of the URL", () => {
    expect(
      [
        "https://bucket.s3.amazonaws.com/q.pdf?X-Amz-Expires=300&X-Amz-Signature=4f1c2a9e0b7d&x-id=GetObject",
        "https://storage.googleapis.com/b/q.pdf?X-Goog-Date=20261112&x-goog-signature=9a8b7c6d5e4f",
        "https://acme.blob.core.windows.net/c/q.pdf?sv=2024-11-04&se=2026-11-13&sig=AbC%2Bd3fG%3D",
        "https://d111.cloudfront.net/q.pdf?Expires=1795000000&Signature=Ab~Cd-Ef__&Key-Pair-Id=K2JCJMDEHXQW5F",
        "https://storage.googleapis.com/b/q.pdf?GoogleAccessId=svc@acme.iam&Expires=1795000000&Signature=ZmFrZQ%3D%3D",
        "https://acme.sharepoint.com/_layouts/15/download.aspx?UniqueId=abc&tempauth=eyJ0eXAi.x.y",
        "https://acme.zoom.us/j/123456789?pwd=QWxhZGRpbjpvcGVu",
      ].map(redact)
    ).toStrictEqual([
      "https://bucket.s3.amazonaws.com/q.pdf?X-Amz-Expires=300&X-Amz-Signature=%5Bredacted%5D&x-id=GetObject",
      "https://storage.googleapis.com/b/q.pdf?X-Goog-Date=20261112&x-goog-signature=%5Bredacted%5D",
      "https://acme.blob.core.windows.net/c/q.pdf?sv=2024-11-04&se=2026-11-13&sig=%5Bredacted%5D",
      "https://d111.cloudfront.net/q.pdf?Expires=1795000000&Signature=%5Bredacted%5D&Key-Pair-Id=K2JCJMDEHXQW5F",
      "https://storage.googleapis.com/b/q.pdf?GoogleAccessId=svc%40acme.iam&Expires=1795000000&Signature=%5Bredacted%5D",
      "https://acme.sharepoint.com/_layouts/15/download.aspx?UniqueId=abc&tempauth=%5Bredacted%5D",
      "https://acme.zoom.us/j/123456789?pwd=%5Bredacted%5D",
    ]);
  });

  it("redacts a signed link in HTML mail, whose separators are written as entities", () => {
    expect(
      redact(
        '<a href="https://d111.cloudfront.net/q.pdf?Expires=1795000000&amp;Signature=Ab~Cd-Ef__&amp;Key-Pair-Id=K2J">Quote</a> <a href="https://acme.blob.core.windows.net/c/q.pdf?sv=2024&#38;sig=AbC%2Bd3fG%3D">Q</a>'
      )
    ).toBe(
      // Written back decoded where something was redacted.
      '<a href="https://d111.cloudfront.net/q.pdf?Expires=1795000000&Signature=%5Bredacted%5D&Key-Pair-Id=K2J">Quote</a> <a href="https://acme.blob.core.windows.net/c/q.pdf?sv=2024&sig=%5Bredacted%5D">Q</a>'
    );
  });

  it("redacts a link's granting parameter however its separator is written: a numeric reference, an upper-case name, or inside a redirect's target", () => {
    const target =
      "https://bucket.s3.amazonaws.com/q.pdf?x=1&X-Amz-Signature=SECRET4";
    expect(
      [
        "https://acme.blob.core.windows.net/c/q.pdf?sv=2024&#x26;sig=SECRET1",
        "https://d111.cloudfront.net/q.pdf?Expires=1795000000&#038;Signature=SECRET2",
        "https://acme.blob.core.windows.net/c/q.pdf?sv=2024&AMP;sig=SECRET3",
        `https://app.acme.test/out?to=${encodeURIComponent(target)}`,
      ].map(redact)
    ).toStrictEqual([
      "https://acme.blob.core.windows.net/c/q.pdf?sv=2024&sig=%5Bredacted%5D",
      "https://d111.cloudfront.net/q.pdf?Expires=1795000000&Signature=%5Bredacted%5D",
      "https://acme.blob.core.windows.net/c/q.pdf?sv=2024&sig=%5Bredacted%5D",
      // The target as a URL writes it, its own value encoded once more.
      `https://app.acme.test/out?${new URLSearchParams({
        to: "https://bucket.s3.amazonaws.com/q.pdf?x=1&X-Amz-Signature=%5Bredacted%5D",
      }).toString()}`,
    ]);
  });

  it("redacts the parameter itself, never a look-alike inside another's value", () => {
    expect(
      redact("https://h.example/f?x=a=SECRET&#59;&sig=SECRET&y=sig=1")
    ).toBe("https://h.example/f?x=a%3DSECRET%3B&sig=%5Bredacted%5D&y=sig%3D1");
  });

  it("reads a megabyte link of many pairs, each holding a reference, in one pass", () => {
    const pairs = 125_000;
    const link = `https://h.example/x?${"a=&#59;&".repeat(pairs)}sig=S`;
    expect(redact(`<a href="${link}">x</a>`)).toBe(
      `<a href="https://h.example/x?${"a=%3B&".repeat(pairs)}sig=%5Bredacted%5D">x</a>`
    );
  });

  it("writes a redacted link back percent-encoded, so nothing it decoded breaks out of what held it", () => {
    const attribute =
      '<a href="https://h/?sig=S&amp;q=&quot;&#32;onmouseover&#61;alert(1)&#32;x&#61;&quot;">t</a> after &amp; more';
    const json = [
      JSON.stringify({ u: "https://h/?sig=S&amp;q=&quot;&#92;", n: 1 }),
      JSON.stringify({
        u: "https://h/?sig=S&amp;q=&quot;,&quot;admin&quot;:true,&quot;x&quot;:&quot;",
      }),
    ];
    const redactedAttribute = redact(attribute);
    const href = /href="(?<link>[^"]*)"/u.exec(redactedAttribute)?.groups?.link;

    expect({
      // The attribute ends where it did, and the text after it is as it was.
      attribute: redactedAttribute.endsWith('">t</a> after &amp; more'),
      href,
      rawInLink: /[\s"<>]/u.test(href ?? ""),
      // Each JSON text still parses, to the same keys.
      json: json.map((text) => {
        const parsed: unknown = JSON.parse(redact(text));
        return Object.keys(z.record(z.string(), z.unknown()).parse(parsed));
      }),
    }).toStrictEqual({
      attribute: true,
      // The link ends before its trailing `;` and the `&quot;` after it
      // (GFM §6.9): they stay as they were written, outside it.
      href: "https://h/?sig=%5Bredacted%5D&q=%22+onmouseover%3Dalert%281%29+x%3D;&quot;",
      rawInLink: false,
      json: [["u", "n"], ["u"]],
    });
  });

  it("ends a link where GitHub Flavored Markdown does, so what follows it stays as it was", () => {
    expect(
      [
        "[Quote](https://h/q?sig=S)",
        "[Quote](https://h/q?sig=S&a=1)",
        "https://h/a_(b)?sig=S",
        "See https://h/q?sig=S.",
        "See https://h/q?sig=S, then",
        "(see https://h/q?sig=S)",
        "(see https://h/q?sig=S).",
        "<https://h/q?sig=S> and 'https://h/q?sig=S'",
        "https://h/q?sig=S&amp;",
      ].map(redact)
    ).toStrictEqual([
      "[Quote](https://h/q?sig=%5Bredacted%5D)",
      "[Quote](https://h/q?sig=%5Bredacted%5D&a=1)",
      "https://h/a_(b)?sig=%5Bredacted%5D",
      "See https://h/q?sig=%5Bredacted%5D.",
      "See https://h/q?sig=%5Bredacted%5D, then",
      "(see https://h/q?sig=%5Bredacted%5D)",
      "(see https://h/q?sig=%5Bredacted%5D).",
      "<https://h/q?sig=%5Bredacted%5D> and 'https://h/q?sig=%5Bredacted%5D'",
      "https://h/q?sig=%5Bredacted%5D&amp;",
    ]);
  });

  it("leaves any text that names no granting parameter byte for byte, wherever its links end", () => {
    // Pieces of links and of what surrounds them, none a granting name.
    const pieces = [
      "https://h.example/",
      "a",
      "?",
      "&",
      "&amp;",
      "&#38;",
      "&lt;",
      "=",
      "(",
      ")",
      ".",
      ",",
      ";",
      ":",
      "_",
      "~",
      "!",
      " ",
      "x=1",
      "%26",
      "#",
      "[t](",
      "<",
      ">",
      "'",
      '"',
    ];
    // A fixed seed: the same texts each run.
    let seed = 1730;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const texts = Array.from({ length: 5000 }, () =>
      Array.from(
        { length: 1 + (next() % 24) },
        () => pieces[next() % pieces.length]
      ).join("")
    );
    expect(texts.filter((text) => redact(text) !== text)).toStrictEqual([]);
  });

  it("ends a megabyte link of closing or of opening parentheses in one pass", () => {
    const closing = ")".repeat(1_000_000);
    const opening = "(".repeat(1_000_000);
    expect([
      redact(`https://h/q?sig=S${closing}`),
      redact(`https://h/q?sig=S${opening}`),
    ]).toStrictEqual([
      `https://h/q?sig=%5Bredacted%5D${closing}`,
      "https://h/q?sig=%5Bredacted%5D",
    ]);
  });

  it("redacts a link's user name and password, and keeps a Markdown link's target apart from the link it names", () => {
    expect(
      [
        // Built from parts, so the source holds no credential to scan.
        `Pull from ${["https://deploy", "hunter2@git.acme.test/repo.git"].join(":")} today`,
        "[https://h/q?sig=S](https://h/doc)",
      ].map(redact)
    ).toStrictEqual([
      "Pull from https://%5Bredacted%5D:%5Bredacted%5D@git.acme.test/repo.git today",
      "[https://h/q?sig=%5Bredacted%5D](https://h/doc)",
    ]);
  });

  it("reads a link to an IPv6 host whole: its user name and password, its port, and inside a Markdown link", () => {
    expect(
      [
        `Get ${withLogin("[2001:db8::1]", "/file?sig=abc")} now`,
        "https://[2001:db8::1]:8443/file?sig=abc",
        `[${withLogin("[::1]", "/f?sig=x")}](https://h/doc)`,
      ].map(redact)
    ).toStrictEqual([
      "Get https://%5Bredacted%5D:%5Bredacted%5D@[2001:db8::1]/file?sig=%5Bredacted%5D now",
      "https://[2001:db8::1]:8443/file?sig=%5Bredacted%5D",
      "[https://%5Bredacted%5D:%5Bredacted%5D@[::1]/f?sig=%5Bredacted%5D](https://h/doc)",
    ]);
  });

  it("leaves a link with nothing to redact, and prose, exactly as they were", () => {
    const texts = [
      '<a href="https://acme.test/report?x=1&amp;y=2&#38;z=3">Report</a>',
      "Our R&amp;D budget, and Tom &amp; Jerry.",
      "Use code=42 in R&D, then sig=abc for the form.",
    ];
    expect(texts.map(redact)).toStrictEqual(texts);
  });

  it("redacts a megabyte of text, links and references in it, in one pass", () => {
    const large = [
      "&amp;".repeat(200_000),
      `&amp;${"a".repeat(1_000_000)}`,
      `https://acme.test/q?sig=${"b".repeat(1_000_000)}`,
      "https://acme.test/q?x=1&amp;Signature=v ".repeat(30_000),
    ];
    expect(large.map((text) => redact(text).length)).toStrictEqual([
      large[0]?.length,
      large[1]?.length,
      "https://acme.test/q?sig=%5Bredacted%5D".length,
      "https://acme.test/q?x=1&Signature=%5Bredacted%5D ".length * 30_000,
    ]);
  });

  it("redacts an OAuth code in a redirect, but not a field merely named for a code", () => {
    expect(
      [
        "https://app.acme.test/callback?code=4%2F0AeanS0b&state=xyz",
        '{"statusCode": 404, "zipcode": "1012 AB", "code": "INVOICE_LATE"}',
      ].map(redact)
    ).toStrictEqual([
      "https://app.acme.test/callback?code=%5Bredacted%5D&state=xyz",
      '{"statusCode": 404, "zipcode": "1012 AB", "code": "INVOICE_LATE"}',
    ]);
  });

  it("redacts session and cookie values, quoted or not", () => {
    expect(
      [
        '{"session": "s3ss10n-value", "sessionId": "abc123"}',
        "JSESSIONID=0F1E2D3C4B5A; Path=/",
        'cookie: "theme=dark; sid=9f8e7d"',
      ].map(redact)
    ).toStrictEqual([
      // JSON: written back compact once something in it is redacted.
      '{"session":"[redacted]","sessionId":"[redacted]"}',
      // An unquoted value runs to whitespace: its `;` goes with it.
      "JSESSIONID=[redacted] Path=/",
      'cookie: "[redacted]"',
    ]);
  });

  it("still redacts what it did before: named values and known formats", () => {
    expect(
      [
        'password: "correct horse battery staple"',
        "access_token=ya29.a0AfH6SMB",
        "key Bearer abcdefghijklmnopqrstuvwxyz0123",
      ].map(redact)
    ).toStrictEqual([
      'password: "[redacted]"',
      "access_token=[redacted]",
      "key [redacted]",
    ]);
  });
});

describe("redacting JSON text by its values", () => {
  /** A session ID, built at run time, so the source holds none to scan. */
  const sessionId = ["s3ss", crypto.randomUUID().replaceAll("-", "")].join("");

  it("redacts the credential on the line after another inside a JSON string, and gives back JSON of the same shape", () => {
    const body = `Hi,\npassword: x\nCookie: sid=${sessionId}\nThanks`;
    const text = JSON.stringify({ id: "m1", body, labels: ["INBOX"] });

    expect(JSON.parse(redact(text))).toStrictEqual({
      id: "m1",
      body: "Hi,\npassword: [redacted]\nCookie: [redacted]\nThanks",
      labels: ["INBOX"],
    });
  });

  it("redacts JSON held as text in a string, however deep, the same way", () => {
    const inner = JSON.stringify({
      note: `password: x\nCookie: sid=${sessionId}`,
    });
    const text = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ result: inner }) }],
    });
    const redacted = redact(text);
    const outer = z
      .object({ content: z.tuple([z.object({ text: z.string() })]) })
      .parse(JSON.parse(redacted));
    const middle = z
      .object({ result: z.string() })
      .parse(JSON.parse(outer.content[0].text));

    expect({
      leaked: redacted.includes(sessionId),
      innermost: z.unknown().parse(JSON.parse(middle.result)),
    }).toStrictEqual({
      leaked: false,
      innermost: { note: "password: [redacted]\nCookie: [redacted]" },
    });
  });

  it("reads an escaped quote as the quote it is, so a value before one is redacted and the JSON still parses", () => {
    const text = JSON.stringify({
      note: `Cookie: sid=${sessionId}"; theme=dark`,
    });

    expect(JSON.parse(redact(text))).toStrictEqual({
      note: 'Cookie: [redacted]"; theme=dark',
    });
  });

  it("redacts a credential's whole value by its member's name, whatever the value is, and a name that is itself a credential", () => {
    const stripeKey = ["sk", "live", "a1b2c3d4e5f6g7h8"].join("_");
    const text = JSON.stringify({
      password: ["first", "second"],
      token: 4_242_424_242,
      "X-Api-Key": { value: "k" },
      headers: { "Set-Cookie": [`sid=${sessionId}`], Accept: "text/html" },
      access_token: null,
      [stripeKey]: "label",
      tokens: 3,
    });

    expect(JSON.parse(redact(text))).toStrictEqual({
      password: "[redacted]",
      token: "[redacted]",
      "X-Api-Key": "[redacted]",
      headers: { "Set-Cookie": "[redacted]", Accept: "text/html" },
      access_token: "[redacted]",
      "[redacted]": "label",
      // Not a credential's name: it doesn't end in one.
      tokens: 3,
    });
  });

  it("writes numbers back as they were written, and a text with nothing to redact byte for byte", () => {
    const untouched = '{\n  "id": 12345678901234567890,\n  "total": 1.50\n}';

    expect([
      redact(
        '{"id": 12345678901234567890, "total": 1.50, "huge": 1e400, "password": "x"}'
      ),
      redact(untouched),
    ]).toStrictEqual([
      '{"id":12345678901234567890,"total":1.50,"huge":1e400,"password":"[redacted]"}',
      untouched,
    ]);
  });

  it("redacts a string inside JSON exactly as the same text alone", () => {
    // Texts the rules over text redact, each also put inside JSON.
    const texts = [
      'password: "correct horse battery staple"',
      "access_token=ya29.a0AfH6SMB and more",
      "key Bearer abcdefghijklmnopqrstuvwxyz0123",
      "https://acme.blob.core.windows.net/c/q.pdf?sv=2024&sig=AbC%2Bd3fG%3D",
      `JSESSIONID=${sessionId}; Path=/`,
      "Nothing to redact here.",
    ];

    expect(
      texts.map((text): unknown => JSON.parse(redact(JSON.stringify({ text }))))
    ).toStrictEqual(texts.map((text) => ({ text: redact(text) })));
  });

  it("redacts text that is not JSON as text, even when it looks like JSON", () => {
    expect(
      [
        // Single quotes, a second document, text around it, cut off.
        "{'password': 'x'}",
        '{"password": "x"}\n{"token": "y"}',
        'Result: {"password": "x"}',
        '{"password": "x", "body": "more',
      ].map(redact)
    ).toStrictEqual([
      "{'password': '[redacted]'}",
      '{"password": "[redacted]"}\n{"token": "[redacted]"}',
      'Result: {"password": "[redacted]"}',
      '{"password": "[redacted]", "body": "more',
    ]);
  });

  it("redacts JSON that holds a member's name twice as text, so neither value is kept with a credential or dropped", () => {
    const password = ["hunt", "er2"].join("");
    const bearer = "abcdefghijklmnopqrstuvwxyz";
    const twice = `{"note":"password: ${password}","note":"fine"}`;
    const texts = [
      twice,
      `{"h":"Authorization: Bearer ${bearer}","h":0}`,
      JSON.stringify({ outer: twice }),
      '{"token":"t1","note":"keep me","note":"and me"}',
    ];
    const redacted = texts.map(redact);

    expect({
      redacted,
      kept: redacted.map(
        (text) => text.includes(password) || text.includes(bearer)
      ),
    }).toStrictEqual({
      redacted: [
        '{"note":"password: [redacted]","note":"fine"}',
        '{"h":"Authorization: [redacted]","h":0}',
        String.raw`{"outer":"{\"note\":\"password: [redacted]\",\"note\":\"fine\"}"}`,
        '{"token":"[redacted]","note":"keep me","note":"and me"}',
      ],
      kept: [false, false, false, false],
    });
  });

  it("takes a `&` into an unquoted value, written as itself or as JSON's `\\u0026`", () => {
    expect(
      [
        String.raw`{"body":"password: ab\u0026hunter2 sent"}`,
        "password: ab&hunter2 sent",
        "https://app.test/login?user=ann&password=hunter2&next=%2F",
      ].map(redact)
    ).toStrictEqual([
      '{"body":"password: [redacted] sent"}',
      "password: [redacted] sent",
      "https://app.test/login?user=ann&password=[redacted]",
    ]);
  });

  it("reads JSON after whitespace or a byte order mark, and keeps the mark", () => {
    const json = JSON.stringify({ b: `password: x\nCookie: sid=${sessionId}` });
    const redacted = [`\n ${json}`, `\uFEFF${json}`].map(redact);

    expect({
      leaked: redacted.map((text) => text.includes(sessionId)),
      marked: redacted.map((text) => text.startsWith("\uFEFF")),
      values: redacted.map((text): unknown =>
        JSON.parse(text.replace(/^\uFEFF/u, ""))
      ),
    }).toStrictEqual({
      leaked: [false, false],
      marked: [false, true],
      values: [
        { b: "password: [redacted]\nCookie: [redacted]" },
        { b: "password: [redacted]\nCookie: [redacted]" },
      ],
    });
  });

  it("redacts a text of JSON by its values for joining, and leaves any other text for the pass over the whole", () => {
    expect(
      [
        JSON.stringify({ body: `password: x\nCookie: sid=${sessionId}` }),
        "Authorization: Bearer",
      ].map(redactJson)
    ).toStrictEqual([
      '{"body":"password: [redacted]\\nCookie: [redacted]"}',
      "Authorization: Bearer",
    ]);
  });

  it("never throws: what JSON's grammar refuses is text, and JSON too deep to read is redacted whole", () => {
    const deep = 1_000_000;
    expect(
      [
        '{"a": "\\ud800", "b": "\\u0000"}',
        '{"__proto__": {"token": "x"}}',
        "{",
        "[1, 2,]",
        '"',
        `${"[".repeat(deep)}"password: x"${"]".repeat(deep)}`,
      ].map(redact)
    ).toStrictEqual([
      '{"a": "\\ud800", "b": "\\u0000"}',
      '{"__proto__":{"token":"[redacted]"}}',
      "{",
      "[1, 2,]",
      '"',
      "[redacted]",
    ]);
  });

  it("redacts a megabyte of JSON in one pass, every value in it", () => {
    const messages = Array.from({ length: 12_000 }, (_, index) => ({
      id: `m${index}`,
      body: `Hi,\npassword: x\nCookie: sid=${sessionId}\nSee you`,
    }));
    const text = JSON.stringify({ messages });
    const nested = JSON.stringify({ text: JSON.stringify({ text }) });
    const redacted = [redact(text), redact(nested)];

    // 15 megabytes in one string, beside a credential's name: more than
    // a pattern over it can step through without overflowing the stack.
    const escapes = JSON.stringify({
      password: "x",
      path: "word ".repeat(3_000_000),
    });

    expect({
      megabyte: text.length > 1_000_000,
      leaked: redacted.map((each) => each.includes(sessionId)),
      escapes: redact(escapes).startsWith('{"password":"[redacted]","path":'),
    }).toStrictEqual({ megabyte: true, leaked: [false, false], escapes: true });
  });
});

describe("never keeping what redaction removed before GRA-1880", () => {
  // Each credential below starts with `Zq`, so it can be found again. The
  // rules before (test/redact-before.ts) are the floor: whatever they
  // removed, the current ones must remove too. Not in the table: a value
  // holding whitespace an escape stands for (`password: ab\thunter2`),
  // which now ends there, as the same text written with a tab does
  // (GRA-2040).
  const password = "Zqhunter2";
  const token = "Zqabcdefghijklmnopqrstuvwx";
  const session = "Zqs3ss10n0123456789abcdef";
  const twice = `{"note":"password: ${password}","note":"fine"}`;
  const lines = `password: x\nCookie: sid=${session}`;
  const texts = [
    // The review's probes.
    twice,
    `{"h":"Authorization: Bearer ${token}","h":0}`,
    JSON.stringify({ outer: twice }),
    String.raw`{"body":"password: ab\u0026${password}"}`,
    `password: ab&${password}`,
    // The issue's case, as JSON, after whitespace and after a mark.
    JSON.stringify({ body: lines }),
    `\n${JSON.stringify({ body: lines })}`,
    `\uFEFF${JSON.stringify({ body: lines })}`,
    JSON.stringify({ text: JSON.stringify({ note: lines }) }),
    // Query strings.
    `https://app.test/login?user=ann&password=${password}&next=%2F`,
    `access_token=${token}&expires_in=3600&token_type=bearer`,
    JSON.stringify({ x: `access_token=${token}&expires_in=3600` }),
    `api_key=${password};x=1`,
    // Headers.
    `Authorization: Basic ${token}`,
    `Authorization: Bearer ${token}\r\nAccept: */*`,
    `Cookie: sid=${session}; theme=dark`,
    `Set-Cookie: sid=${session}; Path=/; HttpOnly`,
    JSON.stringify({ headers: { Cookie: `sid=${session}; theme=dark` } }),
    // Lists.
    `token=${token},${password}`,
    `password: ${password}, then more`,
    `{"password": "${password}", "list": "a, b; c & d"}`,
    JSON.stringify({ items: [{ token }, { note: `secret=${password}` }] }),
    JSON.stringify({ q: `password="${password}"` }),
  ];

  it("gives JSON with nothing to redact by its values exactly what the rules before gave", () => {
    // A name ending one string, its value read by the rules over text
    // from what follows; and JSON those rules leave as it is.
    const unchanged = [
      '["Authorization:", "then the next item"]',
      '{"label": "password:", "hint": "see the vault"}',
      '{\n  "id": 12345678901234567890,\n  "total": 1.50\n}',
    ];

    expect(unchanged.map(redact)).toStrictEqual(unchanged.map(redactBefore));
  });

  it("removes every credential the rules before removed, from each text", () => {
    const keptNow = texts.flatMap((text) => {
      const before = redactBefore(text);
      const now = redact(text);
      return [password, token, session]
        .filter((secret) => text.includes(secret))
        .filter((secret) => !before.includes(secret) && now.includes(secret))
        .map((secret) => ({ text, secret }));
    });
    // And what each rule set keeps of the table, for comparison.
    const kept = (rules: (text: string) => string): number =>
      texts.filter((text) =>
        [password, token, session].some((secret) =>
          rules(text).includes(secret)
        )
      ).length;

    expect({
      keptNow,
      before: kept(redactBefore),
      now: kept(redact),
    }).toStrictEqual({
      keptNow: [],
      // Before: the probes, the issue's case and a comma list.
      before: 6,
      now: 0,
    });
  });
});
