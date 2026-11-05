import { describe, expect, it } from "vite-plus/test";

import {
  authenticationOf,
  parseArcAuthenticationResults,
  parseAuthenticationResults,
  trustedAuthservId,
} from "../src/workflows/authentication-results.ts";

// What a reply's `authentication` reports (authentication-results.ts):
// the RFC 8601 grammar read strictly, and only the topmost results header,
// Email Routing's, believed. The ways it can fail, each closed:
//
// - a sender's own header read as Email Routing's: only the topmost is
//   read, only under Email Routing's authserv-id, and an ARC header only
//   at the message's highest instance;
// - a verdict guessed from a header read loosely: one that isn't the
//   grammar's reports nothing;
// - a DKIM signature of the sender's own domain reported for a message
//   whose From is another's: of several, the one aligned with the From
//   domain is reported;
// - SPF's check of the HELO name reported as the envelope sender's.

/** Each result of `value` as `method=result`, with its properties. */
const resultsOf = (value: string) =>
  parseAuthenticationResults(value)?.results.map(
    ({ method, result, reason, properties }) => ({
      method,
      result,
      reason,
      properties: Object.fromEntries(properties),
    })
  );

/** Headers as postal-mime gives them, topmost first. */
const headers = (...lines: [key: string, value: string][]) =>
  lines.map(([key, value]) => ({ key, value }));

const routing = `i=2; ${trustedAuthservId}`;

describe("Authentication-Results", () => {
  it("parses the RFC's examples, comments, quoted strings and versions included", () => {
    expect({
      none: parseAuthenticationResults("example.org 1; none"),
      spf: resultsOf("example.com; spf=pass smtp.mailfrom=example.net"),
      commented: resultsOf(
        "example.com; (a comment (nested)) auth=pass (cram-md5) smtp.auth=sender@example.net; spf=pass smtp.mailfrom=example.net"
      ),
      reason: resultsOf(
        'example.com; dkim=pass reason="good signature" header.i=@mail-router.example.net; dkim=fail reason="bad signature" header.i=@newyork.example.com'
      ),
      versioned: resultsOf(
        "mail-router.example.net 1; dkim/1 = pass (good signature) header.d = newyork.example.com"
      ),
      quotedLocal: resultsOf(
        'example.com; spf=pass smtp.mailfrom="first last"@example.net'
      ),
    }).toStrictEqual({
      none: { authservId: "example.org", results: [] },
      spf: [
        {
          method: "spf",
          result: "pass",
          reason: undefined,
          properties: { "smtp.mailfrom": "example.net" },
        },
      ],
      commented: [
        {
          method: "auth",
          result: "pass",
          reason: undefined,
          properties: { "smtp.auth": "sender@example.net" },
        },
        {
          method: "spf",
          result: "pass",
          reason: undefined,
          properties: { "smtp.mailfrom": "example.net" },
        },
      ],
      reason: [
        {
          method: "dkim",
          result: "pass",
          reason: "good signature",
          properties: { "header.i": "@mail-router.example.net" },
        },
        {
          method: "dkim",
          result: "fail",
          reason: "bad signature",
          properties: { "header.i": "@newyork.example.com" },
        },
      ],
      versioned: [
        {
          method: "dkim",
          result: "pass",
          reason: undefined,
          properties: { "header.d": "newyork.example.com" },
        },
      ],
      quotedLocal: [
        {
          method: "spf",
          result: "pass",
          reason: undefined,
          properties: { "smtp.mailfrom": "first last@example.net" },
        },
      ],
    });
  });

  it("reads an IPv6 address as is, as Email Routing writes it", () => {
    expect(
      resultsOf(
        `${trustedAuthservId}; arc=none smtp.remote-ip=2a00:1440:4824:20::32e`
      )
    ).toStrictEqual([
      {
        method: "arc",
        result: "none",
        reason: undefined,
        properties: { "smtp.remote-ip": "2a00:1440:4824:20::32e" },
      },
    ]);
  });

  it("refuses anything that isn't the grammar's", () => {
    const refused = [
      "",
      "example.com",
      "example.com;",
      "example.com; spf",
      "example.com; spf=",
      "example.com; spf=pass smtp.mailfrom",
      "example.com; spf=pass smtp=example.net",
      "example.com; spf=pass smtp.mailfrom=a@@example.net",
      "example.com; spf=pass smtp.mailfrom=a@-example.net",
      "example.com; spf=pass smtp.mailfrom=a/b",
      "example.com; spf=pass (never closed",
      'example.com; dkim=pass reason="never closed',
      "example.com 2; spf=pass",
      "example.com; spf=pass; none",
      `example.com; spf=pass (${"(".repeat(20)}deep${")".repeat(20)})`,
      `example.com; spf=pass smtp.mailfrom=${"a".repeat(17_000)}`,
    ];

    // Each one parsed, by its value: none.
    expect(
      refused.filter((value) => parseAuthenticationResults(value) !== undefined)
    ).toStrictEqual([]);
  });

  it("reads an ARC header's instance, from 1 to 50", () => {
    expect({
      read: parseArcAuthenticationResults("i=3; example.com; spf=pass"),
      zero: parseArcAuthenticationResults("i=0; example.com; spf=pass"),
      past: parseArcAuthenticationResults("i=51; example.com; spf=pass"),
      none: parseArcAuthenticationResults("example.com; spf=pass"),
    }).toMatchObject({
      read: { instance: 3, authservId: "example.com" },
      zero: undefined,
      past: undefined,
      none: undefined,
    });
  });
});

describe("a reply's authentication", () => {
  it("reports what Email Routing found: SPF of the envelope sender, DKIM, DMARC", () => {
    expect(
      authenticationOf(
        headers(
          [
            "arc-authentication-results",
            `${routing}; dkim=pass header.d=acme.test header.s=s1 header.b=IRdayjbb; dmarc=pass header.from=acme.test policy.dmarc=reject; spf=none (${trustedAuthservId}: no SPF records found for postmaster@mail.acme.test) smtp.helo=mail.acme.test; spf=pass (${trustedAuthservId}: domain of ben@acme.test designates 2a00:1440::32e as permitted sender) smtp.mailfrom=ben@acme.test; arc=none smtp.remote-ip=2a00:1440::32e`,
          ],
          ["arc-authentication-results", "i=1; mx.acme.test; spf=fail"],
          ["from", "Ben <ben@acme.test>"]
        ),
        "ben@acme.test"
      )
    ).toStrictEqual({
      spf: { result: "pass", domain: "acme.test" },
      dkim: { result: "pass", domain: "acme.test" },
      dmarc: { result: "pass", domain: "acme.test" },
    });
  });

  it("reports the DKIM signature aligned with the From domain, a pass first", () => {
    const of = (value: string) =>
      authenticationOf(
        headers(["authentication-results", `${trustedAuthservId}; ${value}`]),
        "ben@mail.acme.test"
      ).dkim;

    expect({
      aligned: of(
        "dkim=pass header.d=sender.test; dkim=fail header.d=acme.test; dkim=pass header.i=@acme.test"
      ),
      alignedFailing: of(
        "dkim=pass header.d=sender.test; dkim=fail header.d=ACME.test"
      ),
      unaligned: of(
        "dkim=pass header.d=sender.test; dkim=fail header.d=x.test"
      ),
      lookalike: of("dkim=pass header.d=notacme.test"),
    }).toStrictEqual({
      aligned: { result: "pass", domain: "acme.test" },
      alignedFailing: { result: "fail", domain: "acme.test" },
      unaligned: { result: "pass", domain: "sender.test" },
      lookalike: { result: "pass", domain: "notacme.test" },
    });
  });

  it("believes only the topmost header, Email Routing's, of the message's highest ARC instance", () => {
    const forged = `${trustedAuthservId}; dmarc=pass header.from=bank.test`;
    const nothing = { spf: null, dkim: null, dmarc: null };
    const of = (...lines: [string, string][]) =>
      authenticationOf(headers(...lines), "boss@bank.test");

    expect({
      belowRouting: of(
        [
          "arc-authentication-results",
          `${routing}; dmarc=fail header.from=bank.test`,
        ],
        ["authentication-results", forged],
        ["arc-authentication-results", `i=1; ${forged}`]
      ).dmarc,
      onlyForged: of(
        ["received", "from evil.test"],
        ["authentication-results", "mx.evil.test; dmarc=pass"]
      ),
      lookalikeAuthserv: of([
        "authentication-results",
        `${trustedAuthservId}.evil.test; dmarc=pass header.from=bank.test`,
      ]),
      notHighest: of(
        ["arc-authentication-results", `i=1; ${forged}`],
        ["arc-authentication-results", "i=2; mx.acme.test; dmarc=fail"]
      ),
      sameInstanceTwice: of(
        ["arc-authentication-results", `i=2; ${forged}`],
        ["arc-authentication-results", `i=2; ${forged}`]
      ),
      unparsable: of([
        "authentication-results",
        `${trustedAuthservId}; dmarc=pass header.from=bank.test action=none`,
      ]),
      unknownResult: of([
        "authentication-results",
        `${trustedAuthservId}; dmarc=bestguesspass header.from=bank.test`,
      ]).dmarc,
      none: of(["from", "boss@bank.test"]),
    }).toStrictEqual({
      belowRouting: { result: "fail", domain: "bank.test" },
      onlyForged: nothing,
      lookalikeAuthserv: nothing,
      notHighest: nothing,
      sameInstanceTwice: nothing,
      unparsable: nothing,
      unknownResult: null,
      none: nothing,
    });
  });
});
