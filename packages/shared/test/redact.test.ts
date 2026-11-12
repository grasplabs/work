import { describe, expect, it } from "vite-plus/test";

import { redact } from "../src/redact.ts";

// Credentials in what an outside system or code wrote, redacted before it
// reaches a chat, a model, a log or the Brain (src/redact.ts). Pure logic:
// each case is a text as an outside system might answer it.

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
      "https://bucket.s3.amazonaws.com/q.pdf?X-Amz-Expires=300&X-Amz-Signature=[redacted]&x-id=GetObject",
      "https://storage.googleapis.com/b/q.pdf?X-Goog-Date=20261112&x-goog-signature=[redacted]",
      "https://acme.blob.core.windows.net/c/q.pdf?sv=2024-11-04&se=2026-11-13&sig=[redacted]",
      "https://d111.cloudfront.net/q.pdf?Expires=1795000000&Signature=[redacted]&Key-Pair-Id=K2JCJMDEHXQW5F",
      "https://storage.googleapis.com/b/q.pdf?GoogleAccessId=svc@acme.iam&Expires=1795000000&Signature=[redacted]",
      "https://acme.sharepoint.com/_layouts/15/download.aspx?UniqueId=abc&tempauth=[redacted]",
      "https://acme.zoom.us/j/123456789?pwd=[redacted]",
    ]);
  });

  it("redacts a signed link in HTML mail, whose separators are written as entities", () => {
    expect(
      redact(
        '<a href="https://d111.cloudfront.net/q.pdf?Expires=1795000000&amp;Signature=Ab~Cd-Ef__&amp;Key-Pair-Id=K2J">Quote</a> <a href="https://acme.blob.core.windows.net/c/q.pdf?sv=2024&#38;sig=AbC%2Bd3fG%3D">Q</a>'
      )
    ).toBe(
      '<a href="https://d111.cloudfront.net/q.pdf?Expires=1795000000&amp;Signature=[redacted]&amp;Key-Pair-Id=K2J">Quote</a> <a href="https://acme.blob.core.windows.net/c/q.pdf?sv=2024&#38;sig=[redacted]">Q</a>'
    );
  });

  it("redacts an OAuth code in a redirect, but not a field merely named for a code", () => {
    expect(
      [
        "https://app.acme.test/callback?code=4%2F0AeanS0b&state=xyz",
        '{"statusCode": 404, "zipcode": "1012 AB", "code": "INVOICE_LATE"}',
      ].map(redact)
    ).toStrictEqual([
      "https://app.acme.test/callback?code=[redacted]&state=xyz",
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
      '{"session": "[redacted]", "sessionId": "[redacted]"}',
      "JSESSIONID=[redacted]; Path=/",
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
