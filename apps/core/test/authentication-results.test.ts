import { describe, expect, it } from "vite-plus/test";

import {
  authenticationOf,
  trustedAuthservId,
} from "../src/workflows/authentication-results.ts";

// What a reply's `authentication` reports (authentication-results.ts). The
// ways it can fail, written first, each closed below:
//
// - a sender's own results read as Email Routing's: written into the
//   message above or below Email Routing's ARC set, as a plain
//   Authentication-Results header, under a lookalike authserv-id, or in an
//   ARC chain forged so no sealer adds a set on top of it (failed, full,
//   or with a seal hidden from us but not from Email Routing);
// - a result smuggled across a boundary the grammar draws: a `;` inside a
//   comment or a quoted string, an escaped parenthesis closing a comment
//   early;
// - a verdict guessed from a header read loosely, or from a method version
//   or header version whose meaning isn't version 1's;
// - a DKIM signature of the sender's own domain reported for a message
//   whose From is another's, or a value reported as a domain that isn't one;
// - a header crafted to stall the parser.

/** Nothing reported: no results core trusts. */
const nothing = { spf: null, dkim: null, dmarc: null };

/**
 * An ARC set at `instance` (its seal, message signature and results), as
 * postal-mime gives headers (names lower case, topmost first): the seal
 * saying `cv`.
 */
const arcSet = (instance: number, results: string, cv = "none") => [
  {
    key: "arc-seal",
    value: `i=${String(instance)}; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=${cv}; b=abc/def==`,
  },
  {
    key: "arc-message-signature",
    value: `i=${String(instance)}; a=rsa-sha256; c=relaxed/relaxed; d=cloudflare-email.net; s=cf2024-1; h=from:to:subject; bh=x/y=; b=z+w==`,
  },
  {
    key: "arc-authentication-results",
    value: `i=${String(instance)}; ${results}`,
  },
];

/** What Email Routing's own set with `payload` reports of mail from `from`. */
const reportOf = (payload: string, from = "ben@acme.test") =>
  authenticationOf(arcSet(1, payload), from);

/** What Email Routing's results `results` report of mail from Ben. */
const routing = (results: string) =>
  reportOf(`${trustedAuthservId}; ${results}`);

describe("Authentication-Results grammar (RFC 8601 2.2)", () => {
  it("reads comments, quoted strings, versions and CFWS wherever the grammar allows them", () => {
    expect({
      plain: routing(
        "dkim=pass header.d=acme.test; dmarc=pass header.from=acme.test; spf=pass smtp.mailfrom=ben@acme.test"
      ),
      // CFWS around every `=`, `.`, `/` and `;`, comments nested, with
      // quoted pairs (RFC 5322 3.2.2), versions on the header and method.
      spaced: reportOf(
        `(lead) ${trustedAuthservId} (id) 1 (version) ; (a (nested \\) still) comment) dkim (m) / 1 (v) = (r) pass (good) header (p) . (q) d (s) = (t) acme.test (end) ; dmarc=pass reason = "aligned" header.from=acme.test ; spf = pass smtp.mailfrom = "ben"@acme.test (trailing)`
      ),
      // Folded, as postal-mime unfolds a header: its line breaks
      // dropped, its whitespace kept.
      folded: routing(
        "dkim=pass\theader.d=acme.test;  \t dmarc=pass header.from=acme.test"
      ),
      // Every name of the grammar is case-insensitive (RFC 5234 2.3).
      cased: reportOf(
        `${trustedAuthservId.toUpperCase()}; DKIM=PASS Header.D=ACME.test; DMARC=Pass HEADER.FROM=Acme.Test; SPF=pass SMTP.MailFrom=Ben@ACME.TEST`
      ),
      quotedAuthserv: reportOf(
        `"${trustedAuthservId}"; dmarc=pass header.from=acme.test`
      ).dmarc,
    }).toStrictEqual({
      plain: {
        spf: { result: "pass", domain: "acme.test" },
        dkim: { result: "pass", domain: "acme.test" },
        dmarc: { result: "pass", domain: "acme.test" },
      },
      spaced: {
        spf: { result: "pass", domain: "acme.test" },
        dkim: { result: "pass", domain: "acme.test" },
        dmarc: { result: "pass", domain: "acme.test" },
      },
      folded: {
        spf: null,
        dkim: { result: "pass", domain: "acme.test" },
        dmarc: { result: "pass", domain: "acme.test" },
      },
      cased: {
        spf: { result: "pass", domain: "acme.test" },
        dkim: { result: "pass", domain: "acme.test" },
        dmarc: { result: "pass", domain: "acme.test" },
      },
      quotedAuthserv: { result: "pass", domain: "acme.test" },
    });
  });

  it("refuses a `;` inside a comment or quoted string, and keeps an escaped parenthesis inside its comment", () => {
    expect({
      inComment: routing(
        "spf=pass (x; dmarc=pass header.from=bank.test) smtp.mailfrom=x@evil.test"
      ),
      inReason: routing(
        'spf=pass reason="x; dmarc=pass header.from=bank.test" smtp.mailfrom=x@evil.test'
      ),
      inValue: routing('spf=pass smtp.mailfrom="x\\;y"@evil.test'),
      // A quote a sender opens in a value Email Routing writes before its
      // DMARC result (a DKIM `d=` may hold one, RFC 6376 3.2), closed by one
      // written after it, would hide its real result behind a sender's.
      swallowed: routing(
        'dkim=fail header.d=a"b header.s=s; dmarc=fail header.from=bank.test; spf=none smtp.helo=x" ;dmarc=pass header.from=bank.test'
      ),
      // `\)` is a quoted pair (RFC 5322 3.2.1): the comment goes on.
      escapedClose: routing(
        "dkim=pass (x \\) header.d=bank.test) header.d=evil.test"
      ).dkim,
    }).toStrictEqual({
      inComment: nothing,
      inReason: nothing,
      inValue: nothing,
      swallowed: nothing,
      escapedClose: { result: "pass", domain: "evil.test" },
    });
  });

  it("reads property values as receiving servers write them, outside the grammar's tokens too", () => {
    expect(
      routing(
        "dkim=pass header.d=acme.test header.s=s1 header.b=/Gj4+R== (sig); dmarc=pass header.from=acme.test policy.dmarc=reject; spf=none smtp.mailfrom=<> smtp.helo=[192.0.2.1]; arc=none smtp.remote-ip=2a00:1440:4824:20::32e"
      )
    ).toStrictEqual({
      spf: { result: "none", domain: null },
      dkim: { result: "pass", domain: "acme.test" },
      dmarc: { result: "pass", domain: "acme.test" },
    });
  });

  it("reads UTF-8 where RFC 6532 and RFC 6531 allow it", () => {
    expect(
      routing(
        'spf=pass (domaine de jöran) smtp.mailfrom=jöran@acme.test; dmarc=pass reason="geprüft" header.from=acme.test'
      )
    ).toStrictEqual({
      spf: { result: "pass", domain: "acme.test" },
      dkim: null,
      dmarc: { result: "pass", domain: "acme.test" },
    });
  });

  it("reports `; none`, `none` results, and unknown methods, ptypes and results as nothing guessed", () => {
    expect({
      // RFC 8601 2.2's no-result: nothing was checked.
      noResult: reportOf(`${trustedAuthservId} 1; none`),
      noneResult: routing("dmarc=none header.from=acme.test").dmarc,
      unknownMethod: routing(
        "x-custom=pass x-thing.prop=v; dmarc=pass header.from=acme.test"
      ).dmarc,
      unknownPtype: routing("dmarc=pass x-mine.from=bank.test").dmarc,
      unknownResult: routing("dmarc=bestguesspass header.from=acme.test").dmarc,
    }).toStrictEqual({
      noResult: nothing,
      noneResult: { result: "none", domain: "acme.test" },
      unknownMethod: { result: "pass", domain: "acme.test" },
      unknownPtype: { result: "pass", domain: null },
      unknownResult: null,
    });
  });

  it("ignores a method version, and refuses a header version, that isn't 1 (RFC 8601 2.6)", () => {
    expect({
      methodVersion1: routing("dkim/1=pass header.d=acme.test").dkim,
      methodVersion2: routing("dkim/2=pass header.d=acme.test").dkim,
      headerVersion2: reportOf(
        `${trustedAuthservId} 2; dmarc=pass header.from=acme.test`
      ),
    }).toStrictEqual({
      methodVersion1: { result: "pass", domain: "acme.test" },
      methodVersion2: null,
      headerVersion2: nothing,
    });
  });

  it("reports nothing for a header that isn't the grammar's", () => {
    const refused = [
      "",
      trustedAuthservId,
      `${trustedAuthservId};`,
      `${trustedAuthservId}; dmarc=pass header.from=acme.test;`,
      `${trustedAuthservId}; dmarc`,
      `${trustedAuthservId}; dmarc=`,
      `${trustedAuthservId}; dmarc=pass header.from`,
      `${trustedAuthservId}; dmarc=pass header=acme.test`,
      `${trustedAuthservId}; dmarc=pass header.from=`,
      `${trustedAuthservId}; dmarc=pass header.from=a\\b`,
      `${trustedAuthservId}; dmarc=pass header.from=acme.test extra`,
      `${trustedAuthservId}; dmarc=pass action=none header.from=acme.test`,
      `${trustedAuthservId}; dmarc=pass header.from=acme.test reason="late"`,
      `${trustedAuthservId}; dm_arc=pass`,
      `${trustedAuthservId}; "dmarc"=pass`,
      `${trustedAuthservId}; dmarc=pass (never closed`,
      `${trustedAuthservId}; dmarc=pass ) header.from=acme.test`,
      `${trustedAuthservId}; dmarc=pass reason="never closed`,
      `${trustedAuthservId}; dmarc=pass\u0000 header.from=acme.test`,
      `${trustedAuthservId}; dmarc=pass header.from=acme.test; none`,
      `${trustedAuthservId} 1.0; dmarc=pass`,
    ];

    // Each one's report, by its payload: nothing.
    expect(
      refused.filter(
        (payload) =>
          JSON.stringify(reportOf(payload)) !== JSON.stringify(nothing)
      )
    ).toStrictEqual([]);
  });

  it("parses pathological headers in linear time", () => {
    const long = 200_000;
    const results = [
      `${trustedAuthservId}; dmarc=pass (${"(".repeat(long)}${")".repeat(long)}) header.from=acme.test`,
      `${trustedAuthservId}; dmarc=pass (${"\\(".repeat(long)}) header.from=acme.test`,
      `${trustedAuthservId}; dmarc=pass header.from=${"a.".repeat(long)}`,
      `${trustedAuthservId}; dmarc=pass header.from=acme.test (${"(".repeat(long)}`,
      `${trustedAuthservId}; dmarc=pass reason="${'\\"'.repeat(long)}`,
      `${trustedAuthservId}${"; dmarc=pass header.from=acme.test".repeat(long / 10)}`,
    ].map((payload) => reportOf(payload).dmarc);

    expect(results).toStrictEqual([
      { result: "pass", domain: "acme.test" },
      { result: "pass", domain: "acme.test" },
      { result: "pass", domain: null },
      null,
      null,
      { result: "pass", domain: "acme.test" },
    ]);
  });
});

/** What a reply from the boss of bank.test with `lines` reports. */
const bossReport = (...lines: { key: string; value: string }[]) =>
  authenticationOf(lines, "boss@bank.test");

describe("a reply's authentication", () => {
  it("reports what Email Routing found: SPF of the envelope sender, DKIM, DMARC", () => {
    expect(
      authenticationOf(
        [
          ...arcSet(
            2,
            `${trustedAuthservId}; dkim=pass header.d=acme.test header.s=s1 header.b=Gj4cVp/R; dmarc=pass header.from=acme.test policy.dmarc=reject; spf=none (${trustedAuthservId}: no SPF records found for postmaster@mail.acme.test) smtp.helo=mail.acme.test; spf=pass (${trustedAuthservId}: domain of ben@acme.test designates 2a00:1440::32e as permitted sender) smtp.mailfrom=ben@acme.test; arc=pass smtp.remote-ip=2a00:1440::32e`,
            "pass"
          ),
          // Microsoft 365's own, which isn't the grammar's (`action=none`):
          // only its instance is read.
          ...arcSet(
            1,
            "mx.microsoft.com 1; spf=pass smtp.mailfrom=acme.test; dmarc=pass action=none header.from=acme.test; dkim=pass header.d=acme.test; arc=none"
          ),
          { key: "from", value: "Ben <ben@acme.test>" },
        ],
        "ben@acme.test"
      )
    ).toStrictEqual({
      spf: { result: "pass", domain: "acme.test" },
      dkim: { result: "pass", domain: "acme.test" },
      dmarc: { result: "pass", domain: "acme.test" },
    });
  });

  it("reports a domain only when it is one (RFC 6376 3.5's domain-name)", () => {
    expect({
      hyphen: routing("spf=pass smtp.mailfrom=a@-acme.test").spf,
      nullSender: routing("dmarc=none header.from=<>").dmarc,
      oneLabel: routing('spf=pass smtp.mailfrom="acme"').spf,
      trailingDot: routing("dkim=pass header.d=acme.test.").dkim,
      identity: routing("dkim=pass header.i=ben@Mail.Acme.Test").dkim,
      // U+212A KELVIN SIGN lower-cases to an ASCII `k`.
      kelvin: routing("dmarc=none header.from=\u212Araken.com").dmarc,
    }).toStrictEqual({
      hyphen: { result: "pass", domain: null },
      nullSender: { result: "none", domain: null },
      oneLabel: { result: "pass", domain: null },
      trailingDot: { result: "pass", domain: null },
      identity: { result: "pass", domain: "mail.acme.test" },
      kelvin: { result: "none", domain: null },
    });
  });

  it("reports SPF's check of the envelope sender over its check of the HELO name", () => {
    expect(
      routing(
        "spf=pass smtp.helo=mail.evil.test; spf=fail smtp.mailfrom=boss@bank.test"
      ).spf
    ).toStrictEqual({ result: "fail", domain: "bank.test" });
  });

  it("reports the DKIM signature aligned with the From domain, a pass first", () => {
    const of = (value: string) =>
      reportOf(`${trustedAuthservId}; ${value}`, "ben@mail.acme.test").dkim;

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

  it("believes only Email Routing's own ARC set, on top, at the highest instance, of a chain it could extend", () => {
    const forged = `${trustedAuthservId}; dmarc=pass header.from=bank.test`;

    expect({
      belowRouting: bossReport(
        ...arcSet(2, `${trustedAuthservId}; dmarc=fail header.from=bank.test`),
        { key: "authentication-results", value: forged },
        ...arcSet(1, forged)
      ).dmarc,
      // A plain results header is never Email Routing's.
      plain: bossReport({ key: "authentication-results", value: forged }),
      plainAboveRouting: bossReport(
        { key: "authentication-results", value: forged },
        ...arcSet(1, `${trustedAuthservId}; dmarc=fail header.from=bank.test`)
      ).dmarc,
      otherServer: bossReport(...arcSet(1, "mx.evil.test; dmarc=pass")),
      lookalikeAuthserv: bossReport(
        ...arcSet(1, `${trustedAuthservId}.evil.test; dmarc=pass`)
      ),
      // A chain that failed, or is full, takes no set of Email Routing's
      // (RFC 8617 5.1): what is on top is the sender's.
      failedChain: bossReport(...arcSet(1, forged, "fail")),
      fullChain: bossReport(...arcSet(50, forged, "pass")),
      // RFC 5322 4.5's obsolete `name :`, its space kept by postal-mime:
      // a seal Email Routing may read, hiding the set it would add...
      spacedSeal: bossReport(
        { key: "arc-seal ", value: "i=50; a=rsa-sha256; cv=pass; b=x" },
        ...arcSet(1, forged)
      ),
      // ...or a set it may not read, above a chain it stops at.
      spacedSet: bossReport(
        ...arcSet(2, forged, "pass").map(({ key, value }) => ({
          key: `${key} `,
          value,
        })),
        ...arcSet(1, `${trustedAuthservId}; dmarc=fail`, "fail")
      ),
      // A failed seal below the top fails the chain, so Email Routing's
      // own seal on top would say so too.
      failedBelow: bossReport(
        ...arcSet(2, forged, "pass"),
        ...arcSet(1, "mx.acme.test; dmarc=fail", "fail")
      ),
      notHighest: bossReport(
        ...arcSet(1, forged),
        ...arcSet(2, "mx.acme.test; dmarc=fail", "pass")
      ),
      sealedHigher: bossReport(
        { key: "arc-seal", value: "i=3; a=rsa-sha256; cv=pass; b=x" },
        ...arcSet(2, forged, "pass")
      ),
      noSeal: bossReport(
        ...arcSet(1, forged).filter(({ key }) => key !== "arc-seal")
      ),
      noSignature: bossReport(
        ...arcSet(1, forged).filter(
          ({ key }) => key !== "arc-message-signature"
        )
      ),
      signedHigher: bossReport(
        { key: "arc-message-signature", value: "i=2; a=rsa-sha256; b=x" },
        ...arcSet(1, forged)
      ),
      sameInstanceTwice: bossReport(...arcSet(2, forged), ...arcSet(2, forged)),
      unreadableSeal: bossReport(
        { key: "arc-seal", value: "i=1; cv=maybe" },
        ...arcSet(1, forged).filter(({ key }) => key !== "arc-seal")
      ),
      unreadableInstance: bossReport(...arcSet(1, forged), {
        key: "arc-authentication-results",
        value: "i=51; mx.evil.test; none",
      }),
      lowerUnreadable: bossReport(
        ...arcSet(2, `${trustedAuthservId}; dmarc=pass header.from=bank.test`),
        ...arcSet(1, "mx.other.test; dkim=pass (never closed")
      ).dmarc,
      unparsable: bossReport(
        ...arcSet(
          1,
          `${trustedAuthservId}; dmarc=pass header.from=bank.test action=none`
        )
      ),
      none: bossReport({ key: "from", value: "boss@bank.test" }),
    }).toStrictEqual({
      belowRouting: { result: "fail", domain: "bank.test" },
      plain: nothing,
      plainAboveRouting: { result: "fail", domain: "bank.test" },
      otherServer: nothing,
      lookalikeAuthserv: nothing,
      failedChain: nothing,
      fullChain: nothing,
      spacedSeal: nothing,
      spacedSet: nothing,
      failedBelow: nothing,
      notHighest: nothing,
      sealedHigher: nothing,
      noSeal: nothing,
      noSignature: nothing,
      signedHigher: nothing,
      sameInstanceTwice: nothing,
      unreadableSeal: nothing,
      unreadableInstance: nothing,
      lowerUnreadable: { result: "pass", domain: "bank.test" },
      unparsable: nothing,
      none: nothing,
    });
  });
});
