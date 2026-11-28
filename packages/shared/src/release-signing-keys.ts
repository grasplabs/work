/**
 * The keys a release may be signed with
 * (@grasp-os/shared/release-signature), each by its id (the KMS key
 * version's resource name, which a signature file names), with its
 * algorithm and public key. Every verifier trusts exactly these, shipped
 * with the product: the admin's import, Promote release, and an
 * on-premises install, which needs nothing else to check a release.
 * Adding a key here is as good as holding its private half: this file is
 * code-owned (.github/CODEOWNERS).
 *
 * The private keys are in Google Cloud KMS and never leave it; only CI's
 * sign-release job may sign with one (scripts/release/sign-manifest.ts).
 *
 * Rotating: create a new key version in KMS, add its public key here and
 * ship it to every verifier (production's admin is deployed by hand, an
 * on-premises install takes it with a release), then switch the key
 * version in scripts/release/release-signing.json. Drop the old entry
 * once no release that still needs to verify is signed with it. A key
 * that leaked can't be (KMS doesn't export it); one used wrongly is
 * dropped at once, and the releases it signed stop verifying and are
 * published again.
 *
 * Its own module, data only, so the tests can trust a test key instead
 * (packages/shared/test/release-signing-keys.ts): the admin's through an
 * alias (apps/admin/vite.test.config.ts), the release scripts' through a
 * resolve hook (scripts/release/trust-test-key.ts).
 */
import type { ReleaseSigningKey } from "./release-signature.ts";

export const releaseSigningKeys: readonly ReleaseSigningKey[] = [];
