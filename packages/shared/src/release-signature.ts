/**
 * A release's signature: an Ed25519 signature over its manifest's exact
 * bytes, as published (its id stamped), by a key Grasp trusts
 * (@grasp-os/shared/release-signing-keys). The manifest names every blob
 * by its hash, so the signature covers the whole release; it names the
 * release's id too, so a signed manifest can't be published again under
 * another one.
 *
 * It's a small JSON file of its own, beside the manifest rather than in
 * it, so the manifest stays byte for byte what's signed and no verifier
 * has to rebuild a canonical form: in the releases bucket at
 * `signatureKey(<the manifest's SHA-256>)`, written before the manifest,
 * so a manifest is never there without it; in a release directory
 * (Promote release's download, an on-premises install's copy) as
 * `RELEASE_SIGNATURE_FILE` beside `manifest.json`. Keyed by the
 * manifest's hash, not its id: CI's publish signs each id it tries to
 * claim, and one another publish claims first leaves only a signature no
 * manifest has, never one under that publish's id.
 *
 * Releases published before signing began (`SIGNED_FROM`) have none,
 * and verify unsigned where R2 says their manifest was written by then.
 * Every other must be signed: one without, or whose signature doesn't
 * verify, is refused.
 *
 * Why Ed25519 and not GitHub's artifact attestations (Sigstore): every
 * verifier checks it with Web Crypto alone, in workerd and in Node, and
 * an on-premises install needs nothing but these bytes and the keys
 * shipped with it. A Sigstore bundle needs an X.509 and transparency-log
 * verifier, and a trust root that Sigstore rotates a few times a year,
 * which an install that can't reach Sigstore would have to be sent.
 *
 * Nothing but Web APIs: CI (Node), the admin (workerd) and an
 * on-premises install verify with the same code.
 */
import { z } from "zod";

import { fromBase64Url, toBase64Url } from "./encoding.ts";
import { compareReleaseIds, parsePublishedReleaseId } from "./release-id.ts";
import type { Bytes } from "./release.ts";

/**
 * The first release that must be signed: the one after the newest staging
 * published unsigned, 26.11.903, whose manifest R2 says it stored at
 * 00:35:28 UTC on 28 November 2026 (`UNSIGNED_UNTIL`). A release before
 * it verifies unsigned only where R2 says its manifest was written by
 * then: anyone holding the bucket's key can still write a manifest under
 * an old id nobody used, but not backdate it. So only the staging admin's
 * import takes one, of releases it hasn't imported yet; Promote release
 * takes signed releases alone, and production's admin, where a promoted
 * manifest is written later, then imports nothing unsigned. A hard cut,
 * removed once no import is left to take one.
 */
export const SIGNED_FROM = "26.11.904";
export const UNSIGNED_UNTIL = new Date("2026-11-28T00:35:29Z");

/** Where a manifest's signature is in the releases bucket, by the manifest's SHA-256 (hex). */
export const signatureKey = (manifestSha256: string): string =>
  `signatures/${manifestSha256}.json`;

/** A release directory's copy of its manifest's signature, beside `manifest.json`. */
export const RELEASE_SIGNATURE_FILE = "manifest.signature.json";

/** Largest signature file read; one is about 150 bytes. */
export const MAX_SIGNATURE_BYTES = 1024;

const ED25519 = { name: "Ed25519" } as const;
/** Base64url of 32 bytes (a key) and of 64 (a signature), unpadded. */
const KEY_CHARS = 43;
const SIGNATURE_CHARS = 86;

/** A signature file: the key it was made with (its JWK `x`), and the signature, base64url. */
export const releaseSignatureSchema = z.strictObject({
  key: z.string().length(KEY_CHARS),
  signature: z.string().length(SIGNATURE_CHARS),
});

const encoder = new TextEncoder();

/**
 * What's signed: the manifest's bytes behind a fixed context, so a
 * signature made for anything else with the key never passes for one.
 */
const signedBytes = (manifestBytes: Uint8Array): Bytes => {
  const context = encoder.encode("grasp-release-manifest\n");
  const signed = new Uint8Array(context.length + manifestBytes.length);
  signed.set(context);
  signed.set(manifestBytes, context.length);
  return signed;
};

/** An Ed25519 private key as a JWK, as the admin keeps its signing key. */
export interface ReleaseSigningJwk {
  kty: "OKP";
  crv: "Ed25519";
  /** The public key, base64url. */
  x: string;
  /** The private key, base64url. */
  d: string;
}

/** The signature file for `manifestBytes`, made with `jwk`. Ed25519 is deterministic: the same bytes each time. */
export const signReleaseManifest = async (
  manifestBytes: Uint8Array,
  jwk: ReleaseSigningJwk
): Promise<Bytes> => {
  const key = await crypto.subtle.importKey("jwk", jwk, ED25519, false, [
    "sign",
  ]);
  const signature = new Uint8Array(
    await crypto.subtle.sign(ED25519, key, signedBytes(manifestBytes))
  );
  return encoder.encode(
    JSON.stringify({ key: jwk.x, signature: toBase64Url(signature) })
  );
};

/**
 * Whether release `releaseId`, its manifest written at `writtenAt` as R2
 * says, was published before signing began, and may be unsigned.
 */
const mayBeUnsigned = (releaseId: string, writtenAt?: Date): boolean =>
  writtenAt !== undefined &&
  writtenAt < UNSIGNED_UNTIL &&
  parsePublishedReleaseId(releaseId) !== undefined &&
  compareReleaseIds(releaseId, SIGNED_FROM) < 0;

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
 * Why release `releaseId`'s manifest, `manifestBytes` as published,
 * doesn't verify with `signatureBytes` (its signature file, undefined
 * when there's none) against `trusted` keys (the caller's
 * `@grasp-os/shared/release-signing-keys`); undefined when it does.
 * Unsigned, it verifies only as one published before signing began
 * (`SIGNED_FROM`), where `writtenAt`, when R2 says it stored the manifest,
 * is given and early enough. A signature that's there is always checked,
 * also on a release that may be unsigned.
 */
export const releaseSignatureProblem = async (
  releaseId: string,
  manifestBytes: Uint8Array,
  signatureBytes: Uint8Array | undefined,
  trusted: readonly string[],
  writtenAt?: Date
): Promise<string | undefined> => {
  if (signatureBytes === undefined) {
    return mayBeUnsigned(releaseId, writtenAt) ? undefined : "isn't signed";
  }
  const parsed = parsedSignature(signatureBytes);
  if (parsed === undefined) {
    return "has a signature file that isn't one";
  }
  if (!trusted.includes(parsed.key)) {
    return "is signed with a key Grasp doesn't trust";
  }
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: parsed.key },
      ED25519,
      false,
      ["verify"]
    );
    valid = await crypto.subtle.verify(
      ED25519,
      key,
      fromBase64Url(parsed.signature),
      signedBytes(manifestBytes)
    );
  } catch {
    valid = false;
  }
  return valid ? undefined : "has a signature that doesn't match it";
};
