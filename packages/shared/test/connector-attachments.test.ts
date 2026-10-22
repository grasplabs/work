import { describe, expect, it } from "vite-plus/test";

import {
  attachmentLimits,
  attachmentsMatch,
  attachmentsSchema,
} from "../src/connector-attachments.ts";
import { sha256HexOfBytes } from "../src/encoding.ts";

// What a write's attachments are, by digest (GRA-887): the entries an input
// carries, and the bytes that must be exactly those and no others.

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const accepted = (value: unknown): boolean =>
  attachmentsSchema.safeParse(value).success;

const entryOf = async (name: string, text: string) => ({
  name,
  type: "text/plain" as const,
  size: bytesOf(text).length,
  sha256: await sha256HexOfBytes(bytesOf(text)),
});

describe("attachments", () => {
  it("match bytes only when each digest has its part, of its length and hash, and no part has none", async () => {
    const alpha = await entryOf("a.txt", "alpha");
    const twin = { ...alpha, name: "b.txt" };
    const beta = await entryOf("c.txt", "beta");
    const parts = (...texts: string[]) =>
      Object.fromEntries(
        texts.map((text, at) => [
          [alpha, beta][at]?.sha256 ?? "",
          bytesOf(text),
        ])
      );
    expect({
      exact: await attachmentsMatch([alpha, beta], parts("alpha", "beta")),
      twins: await attachmentsMatch([alpha, twin], parts("alpha")),
      none: await attachmentsMatch([], {}),
      missing: await attachmentsMatch([alpha, beta], parts("alpha")),
      extra: await attachmentsMatch([alpha], parts("alpha", "beta")),
      otherContent: await attachmentsMatch([alpha], parts("omega")),
      sameDigestOtherSize: await attachmentsMatch(
        [alpha, { ...twin, size: 4 }],
        parts("alpha")
      ),
    }).toStrictEqual({
      exact: true,
      twins: true,
      none: true,
      missing: false,
      extra: false,
      otherContent: false,
      sameDigestOtherSize: false,
    });
  });

  it("name files as a run file may be named, exactly as written, within the limits of a write", async () => {
    const ok = await entryOf("a.txt", "alpha");
    expect({
      ok: accepted([ok]),
      none: accepted([]),
      padded: accepted([{ ...ok, name: " a.txt" }]),
      path: accepted([{ ...ok, name: "../a.txt" }]),
      newline: accepted([{ ...ok, name: "a\nBcc: x" }]),
      bidi: accepted([
        { ...ok, name: `a${String.fromCodePoint(0x20_2e)}txt.exe` },
      ]),
      unknownType: accepted([{ ...ok, type: "text/html" }]),
      extraField: accepted([{ ...ok, path: "/etc" }]),
      oneAtTheTotal: accepted([{ ...ok, size: attachmentLimits.totalBytes }]),
      eleven: accepted(
        Array.from({ length: attachmentLimits.files + 1 }, () => ok)
      ),
      together: accepted(
        [
          attachmentLimits.fileBytes,
          attachmentLimits.fileBytes,
          1,
          attachmentLimits.fileBytes,
        ].map((size) => ({ ...ok, size }))
      ),
    }).toStrictEqual({
      ok: true,
      none: true,
      padded: false,
      path: false,
      newline: false,
      bidi: false,
      unknownType: false,
      extraField: false,
      oneAtTheTotal: true,
      eleven: false,
      together: false,
    });
  });
});
