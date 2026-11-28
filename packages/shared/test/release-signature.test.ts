import { describe, expect, it } from "vite-plus/test";

import {
  releaseSignatureProblem,
  releaseSignatureSchema,
} from "../src/release-signature.ts";
import {
  releaseSigningKeys,
  signReleaseManifest,
  strangerSigningKey,
  testReleaseSigningKey,
} from "./release-signing-keys.ts";

const encoder = new TextEncoder();

const manifest = encoder.encode(
  `{"releaseId":"26.12.1","commit":"${"a".repeat(40)}"}\n`
);

const problem = async (bytes: Uint8Array, signature?: Uint8Array) =>
  await releaseSignatureProblem(
    bytes,
    signature,
    releaseSigningKeys,
    "26.12.1"
  );

/** `signature` (a signature file) with `fields` in place of its own. */
const withFields = (
  signature: Uint8Array,
  fields: Record<string, unknown>
): Uint8Array =>
  encoder.encode(
    JSON.stringify({
      ...releaseSignatureSchema.parse(
        JSON.parse(new TextDecoder().decode(signature))
      ),
      ...fields,
    })
  );

describe("a release's signature", () => {
  it("verifies the manifest it was made for, and the same signature every time", async () => {
    const signature = await signReleaseManifest(
      manifest,
      testReleaseSigningKey
    );
    expect({
      problem: await problem(manifest, signature),
      again: await signReleaseManifest(manifest, testReleaseSigningKey),
    }).toStrictEqual({ problem: undefined, again: signature });
  });

  it("fails a manifest changed by a single byte", async () => {
    const signature = await signReleaseManifest(
      manifest,
      testReleaseSigningKey
    );
    const changed = Uint8Array.from(manifest);
    // The last character of the commit, still a manifest of 26.12.1.
    changed[changed.length - 4] = "b".codePointAt(0) ?? 0;
    await expect(problem(changed, signature)).resolves.toBe(
      "has a signature that doesn't match it"
    );
  });

  it("fails a key it doesn't trust, a stranger's signature under a trusted key's id, another algorithm, and a file that isn't one", async () => {
    const strangers = await signReleaseManifest(manifest, strangerSigningKey);
    const signature = await signReleaseManifest(
      manifest,
      testReleaseSigningKey
    );
    expect({
      stranger: await problem(manifest, strangers),
      forged: await problem(
        manifest,
        withFields(strangers, { keyId: testReleaseSigningKey.id })
      ),
      otherAlgorithm: await problem(
        manifest,
        withFields(signature, { alg: "ES256" })
      ),
      garbage: await problem(manifest, encoder.encode("{ no")),
      extra: await problem(manifest, withFields(signature, { note: "x" })),
      notBase64Url: await problem(
        manifest,
        withFields(signature, { signature: "not base64url!" })
      ),
    }).toStrictEqual({
      stranger: "is signed with a key Grasp doesn't trust",
      forged: "has a signature that doesn't match it",
      otherAlgorithm: "is signed with ES256, not its key's Ed25519",
      garbage: "has a signature file that isn't one",
      extra: "has a signature file that isn't one",
      notBase64Url: "has a signature that doesn't match it",
    });
  });

  it("fails a signed manifest taken for another release's, one signed as another release's, or bytes naming none, so no verifier can forget to compare the id", async () => {
    const signature = await signReleaseManifest(
      manifest,
      testReleaseSigningKey
    );
    const notJson = encoder.encode("not json");
    expect({
      otherId: await releaseSignatureProblem(
        manifest,
        signature,
        releaseSigningKeys,
        "26.12.2"
      ),
      signedAsAnother: await problem(
        manifest,
        await signReleaseManifest(manifest, testReleaseSigningKey, "26.12.2")
      ),
      noId: await releaseSignatureProblem(
        notJson,
        await signReleaseManifest(notJson, testReleaseSigningKey, "26.12.1"),
        releaseSigningKeys,
        "26.12.1"
      ),
    }).toStrictEqual({
      otherId: "has a manifest of release 26.12.1, not 26.12.2",
      signedAsAnother: "has a signature that doesn't match it",
      noId: "has a manifest of release (none), not 26.12.1",
    });
  });

  it("is refused when it's missing, whatever the release", async () => {
    await expect(problem(manifest)).resolves.toBe("isn't signed");
  });

  it("verifies nothing against no trusted key, as the list ships until a key is put in it", async () => {
    const signature = await signReleaseManifest(
      manifest,
      testReleaseSigningKey
    );
    await expect(
      releaseSignatureProblem(manifest, signature, [], "26.12.1")
    ).resolves.toBe("is signed with a key Grasp doesn't trust");
  });
});
