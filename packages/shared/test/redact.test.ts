import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { redact } from "../src/redact.ts";

// Credentials in what an outside system or code wrote, redacted before it
// reaches a chat, a model, a log or the Brain (src/redact.ts). Pure logic:
// each case is a text as an outside system might answer it.

/**
 * A link to `host` with a user name and password, then `rest`: built from
 * parts, so the source holds no credential to scan.
 */
const withLogin = (host: string, rest: string): string =>
  `https://${["user", "secret"].join(":")}@${host}${rest}`;

/** `length` hex characters, as a session id is written. */
const hex = (length: number): string =>
  "9f8e7d6c5b4a3f2e1d0c".repeat(4).slice(0, length);

/** A session id as a server issues one: 128 bits, as hex. */
const sessionToken = "9f8e7d6c5b4a3f2e".repeat(2);

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
        `{"session": "${sessionToken}", "sessionId": "abc123"}`,
        "JSESSIONID=0F1E2D3C4B5A; Path=/",
        'cookie: "theme=dark; sid=9f8e7d"',
      ].map(redact)
    ).toStrictEqual([
      '{"session": "[redacted]", "sessionId": "[redacted]"}',
      "JSESSIONID=[redacted]; Path=/",
      'cookie: "[redacted]"',
    ]);
  });

  it("leaves ordinary words after session and cookie, or a word ending in one, as they were", () => {
    const texts = [
      "Session: 45 minutes",
      "cookie: chocolate chip",
      "The session=Tuesday morning",
      "Session: Q3 planning",
      '{"summary": "Workshop", "session": "Q3 planning", "cookie": "oatmeal raisin"}',
      "Session: https://meet.acme.test/abc-defg-hij",
      "Possession: 61%, Obsession: coffee",
    ];
    expect(texts.map(redact)).toStrictEqual(texts);
  });

  it("redacts a session token, or a cookie string to its end, after session and cookie", () => {
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiJiZW4ifQ",
      "c2lnbmVkLWJ5LWFjbWU",
    ].join(".");
    expect(
      [
        `Cookie: theme=dark; sid=${sessionToken}; _ga=GA1.2.3`,
        `Set-Cookie: sid=${sessionToken}; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly`,
        `session=${sessionToken}&next=/home`,
        `session: ${jwt}`,
        `{\\"cookie\\":\\"sid=${sessionToken}\\",\\"n\\":1}`,
        `laravel_session=${sessionToken}`,
        `authCookie: '${sessionToken}'`,
      ].map(redact)
    ).toStrictEqual([
      "Cookie: [redacted]",
      "Set-Cookie: [redacted]",
      "session=[redacted]&next=/home",
      "session: [redacted]",
      String.raw`{\"cookie\":\"[redacted]\",\"n\":1}`,
      "laravel_session=[redacted]",
      "authCookie: '[redacted]'",
    ]);
  });

  it("redacts each framework's default session cookie wherever it is written", () => {
    // Each as the framework issues it, built from parts so the source
    // holds none.
    const sessions: readonly (readonly [name: string, value: string])[] = [
      // Laravel: its encrypted payload, base64 JSON, URL-encoded.
      [
        "laravel_session",
        `${["eyJpdiI6IkF4", "ZjR2b1NyM0", "dXZ3ZXJ0eSJ9"].join("")}%3D`,
      ],
      // Rails: base64 data, its padding URL-encoded, `--` and a digest.
      ["_myapp_session", `dGhpcyBpcyBhIHJhaWxz%3D%3D--${hex(40)}`],
      // express-session, named `session`: `s:` URL-encoded, id, signature.
      ["session", `s%3A${hex(24)}.${["AbCdEfGh", "IjKlMnOp"].join("")}`],
      // cookie-session: base64 JSON.
      [
        "session",
        `${["eyJ1c2VySWQi", "OjQyLCJyb2xl", "IjoiYWRtaW4ifQ"].join("")}==`,
      ],
      // A JSON Web Token in a cookie.
      [
        "session",
        [
          "eyJhbGciOiJIUzI1NiJ9",
          "eyJzdWIiOiJiZW4ifQ",
          "c2lnbmVkLWJ5LWFjbWU",
        ].join("."),
      ],
      ["PHPSESSID", hex(26)],
      ["JSESSIONID", hex(32).toUpperCase()],
      ["ASP.NET_SessionId", hex(24)],
      // Django.
      ["sessionid", hex(32)],
    ];
    const contexts: readonly ((name: string, value: string) => string)[] = [
      (name, value) => `Cookie: theme=dark; ${name}=${value}; lang=en`,
      (name, value) => `Set-Cookie: ${name}=${value}; Path=/; HttpOnly`,
      (name, value) => `${name}=${value}`,
      (name, value) => `{"${name}": "${value}", "next": 1}`,
      (name, value) => JSON.stringify(JSON.stringify({ [name]: value })),
      (name, value) => `{ ${name}: '${value}' }`,
      (name, value) => `https://app.acme.test/home?${name}=${value}&tab=1`,
      (name, value) => `(${name}=${value})`,
      (name, value) => `[${name}=${value}]`,
      (name, value) => `{${name}: ${value}}`,
      (name, value) => `<${name}=${value}>`,
      (name, value) => `${name}=${value}!`,
    ];
    const leaked = sessions.flatMap(([name, value]) =>
      contexts
        .map((context) => context(name, value))
        .filter((text) => redact(text).includes(value))
    );
    expect(leaked).toStrictEqual([]);
  });

  it("reads a megabyte of session and cookie names before long runs in one pass", () => {
    // Runs that read as a session's value or a cookie string up to their
    // last character, and then don't.
    const run = "a".repeat(5000);
    const lines = `session: ${run}: cookie: ${run}|\nCookie: a=${run}\n`;
    const flood = "session:".repeat(125_000);
    // Compared whole, so a failure doesn't print a megabyte.
    expect({
      lines:
        redact(lines.repeat(66)) ===
        `session: ${run}: cookie: ${run}|\nCookie: [redacted]\n`.repeat(66),
      flood: redact(flood) === flood,
      cookies: redact(`cookie=${"cookie=".repeat(150_000)}`),
    }).toStrictEqual({
      lines: true,
      flood: true,
      cookies: "cookie=[redacted]",
    });
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
