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

/** A session id as a server issues one: 128 bits, as hex. */
const sessionToken = "9f8e7d6c5b4a3f2e".repeat(2);

/**
 * The named rule as it was before an ordinary word after `session` or
 * `cookie` was kept: its pattern and its replacement, frozen here as the
 * reference.
 */
const redactedBefore = (text: string): string =>
  text.replaceAll(
    /\b(?<name>\w*?(?:api[_-]?key|apikey|token|secret|passwd|password|authorization|session(?:[_-]?id)?|sessid|cookie))(?<between>\\?["']?\s*[:=]\s*)(?:(?<escapedQuote>\\["'])(?:(?!\k<escapedQuote>)[^\n])*(?<escapedClose>\k<escapedQuote>)?|(?<quote>["'])(?:\\.|(?!\k<quote>)[^\\\n])*(?<close>\k<quote>)?|(?:(?:bearer|basic)\s+)?[^\s"'&,;]+)/giu,
    (...args: unknown[]) => {
      const groups = z
        .record(z.string(), z.string().optional())
        .parse(args.at(-1));
      const quote = groups.quote ?? groups.escapedQuote ?? "";
      const close = groups.close ?? groups.escapedClose ?? "";
      return `${groups.name ?? ""}${groups.between ?? ""}${quote}[redacted]${close}`;
    }
  );

/** Any 8 characters of `value` still in `text`: what of it is left. */
const leftOf = (text: string, value: string): string | undefined => {
  for (let at = 0; at + 8 <= value.length; at += 1) {
    const slice = value.slice(at, at + 8);
    if (text.includes(slice)) {
      return slice;
    }
  }
  return undefined;
};

/**
 * Numbers from 0 to 2^32 - 1, the same each run from `seed`: a 64-bit
 * linear congruential generator (Knuth's MMIX constants) in BigInt, so no
 * bit is lost, giving its high 32 bits, the well-mixed ones.
 */
const seeded = (seed: number): (() => number) => {
  let state = BigInt(seed);
  return () => {
    state = BigInt.asUintN(
      64,
      state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n
    );
    return Number(state / 4_294_967_296n);
  };
};

const draw = seeded(2242);

/** `length` characters of `alphabet`, the same each run. */
const drawn = (alphabet: string, length: number): string =>
  Array.from({ length }, () => alphabet[draw() % alphabet.length]).join("");

const hexDigits = "0123456789abcdef";
const base64Url =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Session values as each framework issues them, drawn at run time so the
 * source holds none; `short` to `bottle` are the classes "Not caught"
 * names.
 */
const sessionValues: Record<string, string> = {
  hex: drawn(hexDigits, 32),
  hex64: drawn(hexDigits, 64),
  django: drawn("abcdefghijklmnopqrstuvwxyz0123456789", 32),
  php: drawn("abcdefghijklmnopqrstuv0123456789", 26),
  java: `${drawn("0123456789ABCDEF", 32)}.node0`,
  aspNet: drawn("abcdefghijklmnopqrstuvwxyz012345", 24),
  laravel: `eyJpdiI6${drawn(base64Url, 40)}%3D%3D`,
  rails: `${drawn(base64Url, 24)}%3D%3D--${drawn(hexDigits, 40)}`,
  rails7: `${drawn(base64Url, 40)}--${drawn(base64Url, 16)}%3D--${drawn(base64Url, 22)}%3D%3D`,
  express: `s%3A${drawn(base64Url, 32)}.${drawn(base64Url, 20)}%2B${drawn(base64Url, 10)}`,
  cookieSession: `eyJ${drawn(base64Url, 40)}==`,
  jwt: `eyJ${drawn(base64Url, 20)}.eyJ${drawn(base64Url, 30)}.${drawn(base64Url, 43)}`,
  jwe: `eyJ${drawn(base64Url, 20)}.${drawn(base64Url, 30)}.${drawn(base64Url, 16)}.${drawn(base64Url, 40)}.${drawn(base64Url, 22)}`,
  flask: `.eJw${drawn(base64Url, 40)}.${drawn(base64Url, 6)}.${drawn(base64Url, 27)}`,
  phoenix: `SFMyNTY.${drawn(base64Url, 44)}.${drawn(base64Url, 43)}`,
  gorilla: `MTcw${drawn(base64Url, 60)}`,
  ironSeal: `Fe26.2**${drawn(hexDigits, 64)}*${drawn(base64Url, 22)}*${drawn(base64Url, 40)}**${drawn(hexDigits, 64)}*${drawn(base64Url, 43)}`,
  loadBalancer: `${drawn(base64Url, 14)}==${drawn(base64Url, 40)}`,
  uuid: [8, 4, 4, 4, 12].map((length) => drawn(hexDigits, length)).join("-"),
  short: drawn(hexDigits, 12),
  expressDecoded: `s:${drawn(base64Url, 32)}.${drawn(base64Url, 27)}`,
  userColon: `user:42:${drawn(hexDigits, 32)}`,
  bottle: `!${drawn(base64Url, 24)}?${drawn(base64Url, 40)}`,
};

const sessionNames = [
  "session",
  "Session",
  "cookie",
  "laravel_session",
  "_myapp_session",
  "authCookie",
  "nuxt-session",
  "JSESSIONID",
];

/** Where a session value is written: by hand, in code, in data, in mail. */
const contexts: readonly ((name: string, value: string) => string)[] = [
  (name, value) => `${name}=${value}`,
  (name, value) => `${name}: ${value}`,
  (name, value) => `${name}:${value}`,
  (name, value) => `${name} = ${value}`,
  (name, value) => `{"${name}": "${value}", "next": 1}`,
  (name, value) => JSON.stringify(JSON.stringify({ [name]: value, x: 1 })),
  (name, value) => `{'${name}': '${value}', 'x': 1}`,
  (name, value) => `export ${name}="${value}"`,
  (name, value) => `APP=x\n${name}=${value}\nDEBUG=1`,
  (name, value) => `config:\n  ${name}: ${value}\n  other: 1`,
  (name, value) => `INFO request ${name}=${value}, user=bob`,
  (name, value) => `Login ok with ${name}=${value}.`,
  (name, value) => `${name}: ${value}\r\nNext: x\r\n`,
  (name, value) => `${name}:\t${value}\tok`,
  (name, value) => `${name}=${value}'`,
  (name, value) => `run with \`${name}=${value}\` to reproduce`,
  (name, value) => `${name}: \`${value}\``,
  (name, value) => `<td>${name}=${value}</td>`,
  (name, value) => `${name}: ${value}<br>`,
  (name, value) => `${name}=${value}: expired`,
  (name, value) => `is ${name}=${value}?`,
  (name, value) => `${name}=${value}#top`,
  (name, value) => `**${name}=${value}**`,
  (name, value) => `${name}=${value}@host`,
  (name, value) => `| ${name}=${value}| ok |`,
  (name, value) => `(${name}=${value})`,
  (name, value) => `[${name}=${value}]`,
  (name, value) => `{${name}: ${value}}`,
  (name, value) => `<${name}=${value}>`,
  (name, value) => `${name}=${value}!`,
  (name, value) => `https://app.acme.test/home?${name}=${value}&tab=1`,
  (name, value) => `https://app.acme.test/cb#${name}=${value}`,
  (name, value) => `Cookie: theme=dark; ${name}=${value}; _ga=GA1.2.3`,
  (name, value) => `Set-Cookie: ${name}=${value}; Path=/; HttpOnly`,
  (name, value) => `curl -H 'Cookie: ${name}=${value}' https://x.test`,
  (name, value) => `curl -b "${name}=${value}" https://x.test`,
  (name, value) => `sent \`Cookie: theme=dark; ${name}=${value}\` twice`,
  (name, value) => `<c ${name}="${value}"/>`,
];

/** Everyday words that are, or end in, `session` and `cookie`. */
const proseWords = [
  "session",
  "Session",
  "cookie",
  "Cookie",
  "possession",
  "Obsession",
];

/** What follows them in English and Dutch prose. */
const proseTails = [
  "45 minutes",
  "Q3 planning",
  "chocolate chip",
  "oatmeal raisin, two dozen",
  "Tuesday morning",
  "2 pm in room B",
  "100% attendance",
  "50% off",
  "is it tomorrow?",
  "keep it short.",
  "**Q3 planning**",
  "`Q3 planning`",
  "https://meet.acme.test/abc-defg-hij",
  "woensdag",
  "zie de agenda",
  "om 14:00 uur",
  "de koffie is op",
  "aanmelden via het portaal",
  // What "Not caught" says is blanked the other way: a word of 16 session
  // characters or more (a Dutch compound often is), and `name=value`.
  "internationalisation workshop",
  "kwartaalplanning in zaal 3",
  "onboarding-workshop-for-new-staff",
  "Q3%20planning%20meeting",
  "vanilla=yes, chocolate=no",
];

const proseFrames: readonly ((word: string, tail: string) => string)[] = [
  (word, tail) => `${word}: ${tail}`,
  (word, tail) => `The ${word}: ${tail}`,
  (word, tail) => `De ${word}: ${tail}.`,
  (word, tail) => `${word}=${tail}`,
  (word, tail) => `{"${word}": "${tail}"}`,
  (word, tail) => `Notes\n${word}: ${tail}\nThanks`,
];

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
    const next = seeded(1730);
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

  it("redacts a session value after session and cookie however it is written, and a cookie's first pair", () => {
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiJiZW4ifQ",
      "c2lnbmVkLWJ5LWFjbWU",
    ].join(".");
    expect(
      [
        `Cookie: sid=${sessionToken}; theme=dark`,
        `Set-Cookie: sid=${sessionToken}; Path=/; HttpOnly`,
        `session=${sessionToken}&next=/home`,
        `session: ${jwt}`,
        `{\\"cookie\\":\\"sid=${sessionToken}\\",\\"n\\":1}`,
        `laravel_session=${sessionToken}`,
        `authCookie: '${sessionToken}'`,
        `session: \`${sessionToken}\``,
        // A known format that redacted the start of the value, or a part.
        `session=${jwt}%3D%3D--abcdef0123456789`,
        `session=${jwt}+rest/of==`,
        `cookie: ${jwt}*sealpart`,
        `session=v1.${jwt}%3D%3D--${sessionToken}`,
        // In JSON text, a `/` written `\/`.
        `{"header":"Cookie: sid=${sessionToken}\\/${sessionToken}"}`,
      ].map(redact)
    ).toStrictEqual([
      "Cookie: [redacted]; theme=dark",
      "Set-Cookie: [redacted]; Path=/; HttpOnly",
      "session=[redacted]&next=/home",
      "session: [redacted]",
      String.raw`{\"cookie\":\"[redacted]\",\"n\":1}`,
      "laravel_session=[redacted]",
      "authCookie: '[redacted]'",
      "session: [redacted]",
      "session=[redacted]",
      "session=[redacted]",
      "cookie: [redacted]",
      "session=[redacted]",
      '{"header":"Cookie: [redacted]"}',
    ]);
  });

  it("never leaves what was redacted after session and cookie, but for the classes it names, and leaves prose as it was", () => {
    const leaking = new Set<string>();
    const referenceLeft: string[] = [];
    const partly: string[] = [];
    for (const [label, value] of Object.entries(sessionValues)) {
      for (const name of sessionNames) {
        for (const context of contexts) {
          const text = context(name, value);
          const before = redactedBefore(text);
          const after = redact(text);
          if (leftOf(before, value) !== undefined) {
            referenceLeft.push(text);
          } else if (after !== before && !after.includes(value)) {
            partly.push(text);
          } else if (leftOf(after, value) !== undefined) {
            leaking.add(`${label} ${name}`);
          }
        }
      }
    }
    const changed = new Set<string>();
    for (const word of proseWords) {
      for (const tail of proseTails) {
        for (const frame of proseFrames) {
          const text = frame(word, tail);
          if (redact(text) !== text) {
            changed.add(tail);
          }
        }
      }
    }
    // A session id's name (`JSESSIONID`) redacts whatever follows it.
    const everydayNames = sessionNames.filter((name) => name !== "JSESSIONID");
    expect({
      // Values of many characters, not runs of one.
      uniform: Object.entries(sessionValues)
        .filter(([, value]) => new Set(value).size <= 5)
        .map(([label]) => label),
      // The reference redacts every value in every context, so a leak
      // below is one it never had.
      referenceLeft,
      // Where the output is not the reference's, the value is kept whole,
      // as it was written: never redacted in part.
      partly,
      leaking: [...leaking],
      changed: [...changed],
    }).toStrictEqual({
      uniform: [],
      referenceLeft: [],
      partly: [],
      // "Not caught" in src/redact.ts, each class by one value, after
      // each everyday name.
      leaking: ["short", "expressDecoded", "userColon", "bottle"].flatMap(
        (label) => everydayNames.map((name) => `${label} ${name}`)
      ),
      changed: [
        "internationalisation workshop",
        "kwartaalplanning in zaal 3",
        "onboarding-workshop-for-new-staff",
        "Q3%20planning%20meeting",
        "vanilla=yes, chocolate=no",
      ],
    });
  });

  it("reads a megabyte of session and cookie names before long runs in one pass", () => {
    // Runs that start as a session's value and never become a cookie
    // string, each read once from its name.
    const run = "a".repeat(5000);
    const lines = `session: ${run}| cookie: ${run}|\nCookie: a=${run}\n`;
    const flood = "session:".repeat(125_000);
    const eightMegabytes = "a".repeat(8 * 1024 * 1024);
    // Compared whole, so a failure doesn't print a megabyte.
    expect({
      lines:
        redact(lines.repeat(66)) ===
        "session: [redacted] cookie: [redacted]\nCookie: [redacted]\n".repeat(
          66
        ),
      flood: redact(flood) === flood,
      cookies: redact(`cookie=${"cookie=".repeat(150_000)}`),
      // Eight megabytes in one run.
      session: redact(`session: ${eightMegabytes}!`),
      bearer: redact(`Bearer ${eightMegabytes}`),
      jwt: redact(`eyJ${eightMegabytes}.eyJhbGciOi.c2lnbmVkLWJ5`),
    }).toStrictEqual({
      lines: true,
      flood: true,
      cookies: "cookie=[redacted]",
      session: "session: [redacted]",
      bearer: "[redacted]",
      jwt: "[redacted]",
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
