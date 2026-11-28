/**
 * The public keys a release's manifest may be signed with
 * (@grasp-os/shared/release-signature): Ed25519, each as its JWK `x`
 * (the raw 32-byte key, base64url). Every verifier trusts exactly these,
 * shipped with the product: the admin's import, Promote release, and an
 * on-premises install, which needs nothing else to check a release.
 *
 * The private key is only a secret of the `release-signing` GitHub
 * environment, which only main may use, read by CI's sign-release job
 * alone (scripts/release/sign-manifest.ts): never in Cloudflare or
 * 1Password, never in a job that installs anything.
 *
 * Rotating: add the new key here and ship it to every verifier first
 * (production's admin is deployed by hand, an on-premises install takes
 * it with a release), then replace the environment's secret with the new
 * private key, and drop the old key here once no release that still
 * needs to verify is signed with it. A key that leaked is dropped at
 * once: the releases it signed stop verifying, and are published again.
 *
 * Its own module, data only, so the tests can trust a test key instead
 * (packages/shared/test/release-signing-keys.ts): the admin's through an
 * alias (apps/admin/vite.test.config.ts), the release scripts' through a
 * resolve hook (scripts/release/trust-test-key.ts).
 */
export const releaseSigningKeys: readonly string[] = [];
