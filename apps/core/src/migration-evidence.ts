import { versionErrors } from "@grasp-os/shared/app-releases";
import type { MigrationEvidence } from "@grasp-os/shared/app-releases";
import type { AppId } from "@grasp-os/shared/ids";

import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";

// The gate a release's explicit migrations pass before they touch records
// or run (spec 17.2): what running each on its fixtures found as the
// release was sealed (migration-transform.ts, `migrationEvidence`), which
// the host sealed into the release's manifest. A migration whose fixtures
// failed runs on no records (backfill-run.ts), and its release is never
// made current (apps.ts), even when the store had nothing to transform
// and took its schema at once.

/**
 * The evidence of `release`'s migration `name`, or of the first of its
 * migrations, when `name` is left out, whose fixtures failed; undefined
 * when they passed.
 */
export const failedEvidence = (
  release: Pick<Release, "manifest">,
  name?: string
): MigrationEvidence | undefined =>
  release.manifest.migrationEvidence.find(
    (evidence) =>
      !evidence.passed && (name === undefined || evidence.migration === name)
  );

/**
 * `version.migration_fixtures_failed` for `evidence`: the migration, the
 * fixture (counted from 1, as its author reads them; null when none is to
 * blame) and why. Fixtures are the App's own data, so this is safe to
 * show whoever makes the version current.
 */
export const fixturesFailedError = (evidence: MigrationEvidence): Error =>
  versionErrors.create("version.migration_fixtures_failed", {
    migration: evidence.migration,
    fixture:
      evidence.failure?.fixture === null ||
      evidence.failure?.fixture === undefined
        ? null
        : evidence.failure.fixture + 1,
    reason: evidence.failure?.reason ?? null,
    issues: [...(evidence.failure?.issues ?? [])],
  });

/**
 * Refuses making `version` of `app` current while any of its release's
 * migrations failed on its fixtures (`version.migration_fixtures_failed`).
 */
export const requireMigrationEvidence = async (
  env: Env,
  app: AppId,
  version: number
): Promise<void> => {
  const failed = failedEvidence(await loadRelease(env, app, version));
  if (failed !== undefined) {
    throw fixturesFailedError(failed);
  }
};
