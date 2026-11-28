/**
 * The release signing key the tests trust, in place of production's
 * (src/release-signing-keys.ts): the admin's tests and the release
 * scripts' resolve `@grasp-os/shared/release-signing-keys` here. A key
 * made for the tests alone, so its private half is no secret. And how the
 * tests sign a manifest with a key, as CI's signer does
 * (scripts/release/sign-manifest.ts, whose own tests hold it to the
 * verifier).
 */
import { toBase64Url } from "../src/encoding.ts";
import { releaseSignedBytes } from "../src/release-signature.ts";
import type { Bytes } from "../src/release.ts";

/** An Ed25519 private key as a JWK, as CI's signer takes its key. */
export interface ReleaseSigningJwk {
  kty: "OKP";
  crv: "Ed25519";
  /** The public key, base64url. */
  x: string;
  /** The private key, base64url. */
  d: string;
}

export const testReleaseSigningKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "gTdEWSqKfKnKlaJNunIlce14trGrkUBnZZElyffaa-g",
  d: "Uu6S5RMfGgnnbsiHaXGahNuD-tQRNz9TDW2mj_Jqyzc",
} as const satisfies ReleaseSigningJwk;

export const releaseSigningKeys: readonly string[] = [testReleaseSigningKey.x];

const ED25519 = { name: "Ed25519" } as const;

/** The signature file for `manifestBytes`, made with `jwk`. */
export const signReleaseManifest = async (
  manifestBytes: Uint8Array,
  jwk: ReleaseSigningJwk
): Promise<Bytes> => {
  const key = await crypto.subtle.importKey("jwk", jwk, ED25519, false, [
    "sign",
  ]);
  const signature = new Uint8Array(
    await crypto.subtle.sign(ED25519, key, releaseSignedBytes(manifestBytes))
  );
  return new TextEncoder().encode(
    JSON.stringify({ key: jwk.x, signature: toBase64Url(signature) })
  );
};
