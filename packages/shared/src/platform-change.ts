import { z } from "zod";

import { identifierSchema } from "./ids.ts";

/**
 * What the admin sets as core's `PLATFORM_CHANGE` var on every version
 * it deploys: who made the change, what it was (a release, a setting),
 * the release the version runs and when it was made. Core records it in
 * the deployment's audit log as `platform.updated`, once per version
 * (core's src/platform-updates.ts). Identifiers only, as every audit
 * detail is.
 */
export const platformChangeSchema = z.object({
  /** The staff member, or the rollout, that made the change. */
  by: identifierSchema,
  /**
   * What changed, e.g. `release`, `secrets` (new secrets on the same
   * release: shared ones, or the deployment's own after a rotation),
   * `settings` (its sign-in, on the same release),
   * or `settings_and_secrets` (both in one version).
   */
  what: identifierSchema,
  /** The release the version runs, e.g. `26.01.123`. */
  release: identifierSchema,
  /** When the admin made the change. */
  at: z.iso.datetime(),
});
export type PlatformChange = z.infer<typeof platformChangeSchema>;

/**
 * The header carrying the signature of what the admin sends core:
 * lowercase hex HMAC-SHA256 of the request body, with a key `hkdfHmacKey`
 * derives from core's auth secret for each request's own purpose (core's
 * src/console-signed.ts).
 */
export const platformUpdateSignatureHeader = "x-grasp-console-signature";
