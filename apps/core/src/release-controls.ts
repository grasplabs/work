import { versionErrors } from "@grasp-os/shared/app-releases";
import {
  appErrors,
  appVersionSchema,
  releaseHoldSchema,
  releaseRevocationSchema,
} from "@grasp-os/shared/apps";
import type { AppRelease } from "@grasp-os/shared/apps";
import type { AppId } from "@grasp-os/shared/ids";
import { identifierSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { findApp } from "./apps.ts";
import type { Acting } from "./auth/identity.ts";
import { sdkReleaseManifests, sdkReleasePins } from "./db/core/schema.ts";
import { requireMemberAdmin } from "./permissions.ts";
import { placeHold, releaseHold, revokeRelease } from "./release-retention.ts";

// An admin's controls over an App's sealed releases (spec 16.3), as
// `apps.versions` serves them: reading which were revoked and which legal
// holds keep them, revoking one, and placing or lifting a hold. What each
// does, and what stops it going wrong, is in release-retention.ts. Here:
//
// - Someone else revoking or holding: the organization's own admins
//   only, never Grasp staff, checked before the App is even looked up,
//   so nobody else learns which Apps or releases exist; a demoted admin's
//   session is refused by the write itself (release-retention.ts).
// - Revoking or holding a version that wasn't sealed: refused
//   (`version.not_sealed`); there is nothing to keep or stop.
// - Releases of a removed App: answered as one that isn't there.

/** Most releases one page of `releases` holds. */
const releasesPerPage = 100;

type Admin = Identity & Pick<Acting, "actor">;

/** App `app`, for `by`, an admin of the organization. */
const adminsApp = async (env: Env, by: Identity, app: unknown) => {
  requireMemberAdmin(by);
  return await findApp(env, app);
};

/** The release of version `version` of App `app`, for `by`, an admin. */
const releaseKeyFor = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<{ app: AppId; version: number }> => {
  const { id } = await adminsApp(env, by, app);
  return {
    app: id,
    version: appErrors.parse("app.invalid", appVersionSchema, version),
  };
};

/** App `app`'s releases at `versions`, or all from before `before`, newest first. */
const releasesOf = async (
  env: Env,
  app: AppId,
  { before, version }: { before?: number; version?: number }
): Promise<AppRelease[]> => {
  const db = drizzle(env.DB);
  const manifests = await db
    .select({
      version: sdkReleaseManifests.version,
      manifestHash: sdkReleaseManifests.manifestHash,
      sealedAt: sdkReleaseManifests.sealedAt,
      revokedAt: sdkReleaseManifests.revokedAt,
    })
    .from(sdkReleaseManifests)
    .where(
      and(
        eq(sdkReleaseManifests.appId, app),
        before === undefined
          ? undefined
          : lt(sdkReleaseManifests.version, before),
        version === undefined
          ? undefined
          : eq(sdkReleaseManifests.version, version)
      )
    )
    .orderBy(desc(sdkReleaseManifests.version))
    .limit(releasesPerPage);
  const holds =
    manifests.length === 0
      ? []
      : await db
          .select({
            version: sdkReleasePins.version,
            hold: sdkReleasePins.holderId,
            placedAt: sdkReleasePins.pinnedAt,
          })
          .from(sdkReleasePins)
          .where(
            and(
              eq(sdkReleasePins.appId, app),
              eq(sdkReleasePins.holderKind, "hold"),
              inArray(
                sdkReleasePins.version,
                manifests.map((manifest) => manifest.version)
              )
            )
          )
          .orderBy(asc(sdkReleasePins.pinnedAt), asc(sdkReleasePins.holderId));
  return manifests.map((manifest) => ({
    app,
    version: manifest.version,
    manifestHash: manifest.manifestHash,
    sealedAt: manifest.sealedAt.toISOString(),
    revokedAt: manifest.revokedAt?.toISOString() ?? null,
    holds: holds
      .filter((hold) => hold.version === manifest.version)
      .map(({ hold, placedAt }) => ({
        hold,
        placedAt: placedAt.toISOString(),
      })),
  }));
};

/** Release `key`, as it is now; `version.not_sealed` if it never was. */
const releaseNow = async (
  env: Env,
  key: { app: AppId; version: number }
): Promise<AppRelease> => {
  const [release] = await releasesOf(env, key.app, { version: key.version });
  if (release === undefined) {
    throw versionErrors.create("version.not_sealed");
  }
  return release;
};

/**
 * App `app`'s sealed releases, newest first, at most a page from before
 * `before`, for `by`, an admin of the organization.
 */
export const listReleases = async (
  env: Env,
  by: Identity,
  app: unknown,
  before?: unknown
): Promise<AppRelease[]> => {
  const { id } = await adminsApp(env, by, app);
  const until =
    before === undefined
      ? undefined
      : appErrors.parse("app.invalid", appVersionSchema, before);
  return await releasesOf(env, id, { before: until });
};

/** Revokes release `version` of App `app` for `by`, an admin, with why. */
export const revokeAppRelease = async (
  env: Env,
  by: Admin,
  app: unknown,
  version: unknown,
  input: unknown
): Promise<AppRelease> => {
  const key = await releaseKeyFor(env, by, app, version);
  const { reason } = appErrors.parse(
    "app.invalid",
    releaseRevocationSchema,
    input
  );
  await revokeRelease(env, by, key, reason);
  return await releaseNow(env, key);
};

/** Places a legal hold on release `version` of App `app`, for `by`, an admin. */
export const holdAppRelease = async (
  env: Env,
  by: Admin,
  app: unknown,
  version: unknown,
  input: unknown
): Promise<AppRelease> => {
  const key = await releaseKeyFor(env, by, app, version);
  const { hold, reason } = appErrors.parse(
    "app.invalid",
    releaseHoldSchema,
    input
  );
  await placeHold(env, by, key, hold, reason);
  return await releaseNow(env, key);
};

/** Lifts legal hold `hold` from release `version` of App `app`, for `by`, an admin. */
export const liftAppReleaseHold = async (
  env: Env,
  by: Admin,
  app: unknown,
  version: unknown,
  hold: unknown
): Promise<AppRelease> => {
  const key = await releaseKeyFor(env, by, app, version);
  const name = appErrors.parse("app.invalid", identifierSchema, hold);
  await releaseHold(env, by, key, name);
  return await releaseNow(env, key);
};
