/**
 * The release signing key the tests trust, in place of production's
 * (src/release-signing-keys.ts): the admin's tests and the release
 * scripts' resolve `@grasp-os/shared/release-signing-keys` here. A key
 * made for the tests alone, so its private half is no secret. And how the
 * tests sign a manifest with a key, as CI's signer has KMS sign it
 * (scripts/release/sign-manifest.ts, whose own tests hold it to the
 * verifier).
 */
import { z } from "zod";

import { toBase64Url } from "../src/encoding.ts";
import { releaseSignedBytes } from "../src/release-signature.ts";
import type { ReleaseSigningKey } from "../src/release-signature.ts";
import type { Bytes } from "../src/release.ts";

/** A signing key of the tests': its id, as a KMS key version's, and its Ed25519 private key as a JWK. */
export interface TestSigningKey {
  id: string;
  jwk: {
    kty: "OKP";
    crv: "Ed25519";
    /** The public key, base64url. */
    x: string;
    /** The private key, base64url. */
    d: string;
  };
}

export const testReleaseSigningKey = {
  id: "projects/grasp-test/locations/europe-west4/keyRings/grasp-releases/cryptoKeys/release-signing/cryptoKeyVersions/1",
  jwk: {
    kty: "OKP",
    crv: "Ed25519",
    x: "gTdEWSqKfKnKlaJNunIlce14trGrkUBnZZElyffaa-g",
    d: "Uu6S5RMfGgnnbsiHaXGahNuD-tQRNz9TDW2mj_Jqyzc",
  },
} as const satisfies TestSigningKey;

/** A key nobody trusts: an attacker's, under an id of its own. */
export const strangerSigningKey = {
  id: "projects/attacker/locations/europe-west4/keyRings/grasp-releases/cryptoKeys/release-signing/cryptoKeyVersions/1",
  jwk: {
    kty: "OKP",
    crv: "Ed25519",
    x: "A2VEuP3eHRFGIPqELZm-RDZnYWKhUXJLPFsDL5Y8xVY",
    d: "7Bs1IAjNMwqAVTTNRQkEsTjYn2p3b4Vz3RhHn0GXi8o",
  },
} as const satisfies TestSigningKey;

export const releaseSigningKeys: readonly ReleaseSigningKey[] = [
  {
    id: testReleaseSigningKey.id,
    alg: "Ed25519",
    // The SPKI of `testReleaseSigningKey.jwk.x`, as a PEM's body.
    publicKey: "MCowBQYDK2VwAyEAgTdEWSqKfKnKlaJNunIlce14trGrkUBnZZElyffaa+g=",
  },
];

const ED25519 = { name: "Ed25519" } as const;

/** The release id `manifestBytes` name, "" when they name none. */
const namedId = (manifestBytes: Uint8Array): string => {
  try {
    return (
      z
        .looseObject({ releaseId: z.string() })
        .safeParse(JSON.parse(new TextDecoder().decode(manifestBytes))).data
        ?.releaseId ?? ""
    );
  } catch {
    return "";
  }
};

/**
 * The signature file for `manifestBytes` as release `releaseId` (the id
 * they name unless given), made with `key`.
 */
export const signReleaseManifest = async (
  manifestBytes: Uint8Array,
  key: TestSigningKey,
  releaseId = namedId(manifestBytes)
): Promise<Bytes> => {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    key.jwk,
    ED25519,
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      ED25519,
      privateKey,
      await releaseSignedBytes(releaseId, manifestBytes)
    )
  );
  return new TextEncoder().encode(
    JSON.stringify({
      alg: "Ed25519",
      keyId: key.id,
      signature: toBase64Url(signature),
    })
  );
};
