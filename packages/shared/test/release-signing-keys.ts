/**
 * The release signing key the tests trust, in place of production's
 * (src/release-signing-keys.ts): the admin's tests and the release
 * scripts' resolve `@grasp-os/shared/release-signing-keys` here. A key
 * made for the tests alone, so its private half is no secret.
 */
export const testReleaseSigningKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "gTdEWSqKfKnKlaJNunIlce14trGrkUBnZZElyffaa-g",
  d: "Uu6S5RMfGgnnbsiHaXGahNuD-tQRNz9TDW2mj_Jqyzc",
} as const;

export const releaseSigningKeys: readonly string[] = [testReleaseSigningKey.x];
