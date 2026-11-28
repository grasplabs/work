import { describe, expect, it } from "vite-plus/test";

import { parsePublishedReleaseId } from "../src/release-id.ts";
import {
  releaseSignatureProblem,
  releaseSignatureSchema,
  SIGNED_FROM,
  signReleaseManifest,
  UNSIGNED_UNTIL,
} from "../src/release-signature.ts";
import type { ReleaseSigningJwk } from "../src/release-signature.ts";
import {
  releaseSigningKeys,
  testReleaseSigningKey,
} from "./release-signing-keys.ts";

const encoder = new TextEncoder();

/** A key nobody trusts. */
const stranger: ReleaseSigningJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "A2VEuP3eHRFGIPqELZm-RDZnYWKhUXJLPFsDL5Y8xVY",
  d: "7Bs1IAjNMwqAVTTNRQkEsTjYn2p3b4Vz3RhHn0GXi8o",
};

const manifest = encoder.encode(
  `{"releaseId":"${SIGNED_FROM}","commit":"${"a".repeat(40)}"}\n`
);

/** The release just before signing began. */
const lastUnsigned = (() => {
  const parts = parsePublishedReleaseId(SIGNED_FROM);
  if (parts === undefined || parts.n < 2) {
    throw new Error("SIGNED_FROM is a published id past its month's first");
  }
  return SIGNED_FROM.replace(/\d+$/u, String(parts.n - 1));
})();

const problem = async (id: string, bytes: Uint8Array, signature?: Uint8Array) =>
  await releaseSignatureProblem(id, bytes, signature, releaseSigningKeys);

describe("a release's signature", () => {
  it("verifies the manifest it was made for, and the same signature every time", async () => {
    const signature = await signReleaseManifest(
      manifest,
      testReleaseSigningKey
    );
    expect({
      problem: await problem(SIGNED_FROM, manifest, signature),
      again: await signReleaseManifest(manifest, testReleaseSigningKey),
    }).toStrictEqual({ problem: undefined, again: signature });
  });

  it("fails a manifest changed by a single byte", async () => {
    const signature = await signReleaseManifest(
      manifest,
      testReleaseSigningKey
    );
    const changed = Uint8Array.from(manifest);
    changed[changed.length - 2] = "?".codePointAt(0) ?? 0;
    await expect(problem(SIGNED_FROM, changed, signature)).resolves.toBe(
      "has a signature that doesn't match it"
    );
  });

  it("fails a signature by a key it doesn't trust, or one that isn't a signature", async () => {
    const strangers = await signReleaseManifest(manifest, stranger);
    const parsed = releaseSignatureSchema.parse(
      JSON.parse(new TextDecoder().decode(strangers))
    );
    const forged = encoder.encode(
      JSON.stringify({
        key: testReleaseSigningKey.x,
        signature: parsed.signature,
      })
    );
    expect({
      stranger: await problem(SIGNED_FROM, manifest, strangers),
      forged: await problem(SIGNED_FROM, manifest, forged),
      garbage: await problem(SIGNED_FROM, manifest, encoder.encode("{ no")),
      extra: await problem(
        SIGNED_FROM,
        manifest,
        encoder.encode(JSON.stringify({ ...parsed, note: "x" }))
      ),
    }).toStrictEqual({
      stranger: "is signed with a key Grasp doesn't trust",
      forged: "has a signature that doesn't match it",
      garbage: "has a signature file that isn't one",
      extra: "has a signature file that isn't one",
    });
  });

  it("may be missing only from a published release before signing began whose manifest R2 stored by then, never from a later one or a local build", async () => {
    const early = new Date(UNSIGNED_UNTIL.getTime() - 60_000);
    const unsigned = async (id: string, writtenAt?: Date) =>
      await releaseSignatureProblem(
        id,
        manifest,
        undefined,
        releaseSigningKeys,
        writtenAt
      );
    expect({
      before: await unsigned(lastUnsigned, early),
      // Under an old id nobody used, written since: anyone with the
      // bucket's key could.
      beforeWrittenSince: await unsigned(lastUnsigned, UNSIGNED_UNTIL),
      beforeNotKnownWhen: await unsigned(lastUnsigned),
      first: await unsigned(SIGNED_FROM, early),
      nextYear: await unsigned("27.01.1", early),
      local: await unsigned("dev-abc", early),
    }).toStrictEqual({
      before: undefined,
      beforeWrittenSince: "isn't signed",
      beforeNotKnownWhen: "isn't signed",
      first: "isn't signed",
      nextYear: "isn't signed",
      local: "isn't signed",
    });
  });

  it("is checked when there is one, also on a release before signing began", async () => {
    const strangers = await signReleaseManifest(manifest, stranger);
    await expect(problem(lastUnsigned, manifest, strangers)).resolves.toBe(
      "is signed with a key Grasp doesn't trust"
    );
  });
});
