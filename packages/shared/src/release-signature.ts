/**
 * A release's signature, by a key Grasp trusts
 * (@grasp-os/shared/release-signing-keys), over a short message that
 * names the release: "grasp-release-manifest\n", its id, "\n", and the
 * SHA-256 (hex) of its manifest's exact bytes, as published (its id
 * stamped). The manifest names every blob by its hash, so the signature
 * covers the whole release, and the id is in the message, so a signed
 * manifest can't be published again under another id. A hash rather than
 * the manifest itself: the key's service takes what it signs in one
 * request, and a manifest names over a thousand blobs; the message stays
 * under 120 bytes however large the release grows.
 *
 * CI signs it in a job of its own, `sign-release` in
 * .github/workflows/ci.yml, with a key that never leaves Google Cloud KMS
 * (scripts/release/sign-manifest.ts); everything else only verifies, with
 * the code here.
 *
 * It's a small JSON file of its own, beside the manifest rather than in
 * it, so the manifest stays byte for byte what's hashed: `alg` (the
 * signature's algorithm), `keyId` (the key's id in the trusted list, the
 * KMS key version's resource name) and `signature` (base64url). Each
 * trusted key carries its algorithm, so a new key or another algorithm is
 * a new entry beside the old, and the releases signed before still
 * verify. In the releases bucket it's at `signatureKey(<the manifest's
 * SHA-256>)`, written before the manifest, so a manifest is never there
 * without it; in a release directory (CI's publish, Promote release's
 * download, an on-premises install's copy) it's `RELEASE_SIGNATURE_FILE`
 * beside `manifest.json`. Keyed by the manifest's hash, not its id: a
 * publish that loses its id leaves only a signature no manifest has,
 * never one under that id. Such a signature, or one in a CI run's
 * artifacts, stays valid: whoever can write the bucket could publish that
 * manifest, a real build of main, under its id while the id is free. It
 * sorts before every later release.
 *
 * Every release must be signed: one without, or whose signature doesn't
 * verify, is refused. Releases imported before signing began are never
 * checked again; one published unsigned and not imported yet never is.
 *
 * Why a key of our own and not GitHub's artifact attestations (Sigstore):
 * every verifier checks it with Web Crypto alone, in workerd and in Node,
 * and an on-premises install needs nothing but these bytes and the keys
 * shipped with it, offline. A Sigstore bundle needs an X.509 and
 * transparency-log verifier, and a trust root that Sigstore rotates a few
 * times a year, which an install that can't reach Sigstore would have to
 * be sent.
 *
 * Nothing but Web APIs: CI (Node), the admin (workerd) and an
 * on-premises install verify with the same code.
 */
import { z } from "zod";

import { fromBase64, fromBase64Url, sha256HexOfBytes } from "./encoding.ts";
import type { Bytes } from "./release.ts";

/** Where a manifest's signature is in the releases bucket, by the manifest's SHA-256 (hex). */
export const signatureKey = (manifestSha256: string): string =>
  `signatures/${manifestSha256}.json`;

/** A release directory's copy of its manifest's signature, beside `manifest.json`. */
export const RELEASE_SIGNATURE_FILE = "manifest.signature.json";

/** Largest signature file read; one is about 250 bytes. */
export const MAX_SIGNATURE_BYTES = 1024;

/** The algorithms a release may be signed with, as Web Crypto names them. */
export type ReleaseSigningAlgorithm = "Ed25519";

/**
 * A key a release may be signed with: its id, which a signature file
 * names (the KMS key version's resource name), its algorithm, and its
 * public key as SPKI DER in base64: the body of the PEM that `gcloud kms
 * keys versions get-public-key` writes.
 */
export interface ReleaseSigningKey {
  id: string;
  alg: ReleaseSigningAlgorithm;
  publicKey: string;
}

/** A signature file: the algorithm, the key's id and the signature (base64url). */
export const releaseSignatureSchema = z.strictObject({
  alg: z.string().max(32),
  keyId: z.string().min(1).max(512),
  signature: z.string().max(256),
});

const encoder = new TextEncoder();

/**
 * What's signed for release `releaseId` whose manifest is
 * `manifestBytes`: the id and the manifest's SHA-256 behind a fixed
 * context, so a signature made for anything else with the key never
 * passes for one. CI's signer (scripts/release/sign-manifest.ts) builds
 * the same bytes with Node alone; its tests verify what it signs here.
 */
export const releaseSignedBytes = async (
  releaseId: string,
  manifestBytes: Uint8Array
): Promise<Bytes> =>
  encoder.encode(
    `grasp-release-manifest\n${releaseId}\n${await sha256HexOfBytes(manifestBytes)}`
  );

const parsedSignature = (
  signatureBytes: Uint8Array
): z.infer<typeof releaseSignatureSchema> | undefined => {
  try {
    return releaseSignatureSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(signatureBytes)
      )
    );
  } catch {
    return undefined;
  }
};

/**
 * The release id a manifest's bytes name, or undefined when they aren't
 * a JSON object naming one.
 */
const namedReleaseId = (manifestBytes: Uint8Array): string | undefined => {
  try {
    const named = z
      .looseObject({ releaseId: z.string() })
      .safeParse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)
        )
      );
    return named.success ? named.data.releaseId : undefined;
  } catch {
    return undefined;
  }
};

/** Whether `signature` (base64url) is `key`'s over `signed`. */
const verifies = async (
  key: ReleaseSigningKey,
  signature: string,
  signed: Bytes
): Promise<boolean> => {
  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      fromBase64(key.publicKey),
      { name: key.alg },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: key.alg },
      publicKey,
      fromBase64Url(signature),
      signed
    );
  } catch {
    return false;
  }
};

/**
 * Why a manifest, `manifestBytes` as published, isn't release
 * `releaseId`'s, signed: it doesn't name that id (so a signed manifest
 * never passes under another), or doesn't verify with `signatureBytes`
 * (its signature file, undefined when there's none) against `trusted`
 * keys (the caller's `@grasp-os/shared/release-signing-keys`); undefined
 * when it is. An empty `trusted` verifies nothing.
 */
export const releaseSignatureProblem = async (
  manifestBytes: Uint8Array,
  signatureBytes: Uint8Array | undefined,
  trusted: readonly ReleaseSigningKey[],
  releaseId: string
): Promise<string | undefined> => {
  const named = namedReleaseId(manifestBytes);
  if (named !== releaseId) {
    return `has a manifest of release ${named ?? "(none)"}, not ${releaseId}`;
  }
  if (signatureBytes === undefined) {
    return "isn't signed";
  }
  const parsed = parsedSignature(signatureBytes);
  if (parsed === undefined) {
    return "has a signature file that isn't one";
  }
  const key = trusted.find((each) => each.id === parsed.keyId);
  if (key === undefined) {
    return "is signed with a key Grasp doesn't trust";
  }
  if (parsed.alg !== key.alg) {
    return `is signed with ${parsed.alg}, not its key's ${key.alg}`;
  }
  const valid = await verifies(
    key,
    parsed.signature,
    await releaseSignedBytes(releaseId, manifestBytes)
  );
  return valid ? undefined : "has a signature that doesn't match it";
};
