import { versionErrors } from "@grasp-os/shared/app-releases";
import type { MigrationEvidence } from "@grasp-os/shared/app-releases";
import type { AppId } from "@grasp-os/shared/ids";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sealedEvidence } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";

// The gate a release's explicit migrations pass before they touch records
// or run (spec 17.2): what running each on its fixtures found as the
// release was sealed (migration-transform.ts, `migrationEvidence`), which
// the host sealed into the release's manifest. A migration whose fixtures
// failed runs on no records (backfill-run.ts), and its release is never
// made current (apps.ts), even when the store had nothing to transform
// and took its schema at once. And what an admin's dry run on a sample of
// real records last found (migration-samples.ts): a release one of whose
// migrations' samples failed isn't made current until a later sample
// passes on at least as many records, or finds none left to transform. That is what keeps readers off what the transform does
// to real records: the backfill only expands, and validates every record
// it writes, so it runs on (stopping a whole migration would strand its
// target until an admin abandons it). Whether a sample was taken at all
// doesn't gate: a sample needs an admin.

/**
 * The evidence of `release`'s migration `name`, or of the first of its
 * migrations, when `name` is left out, whose fixtures failed; undefined
 * when they passed.
 */
export const failedEvidence = (
  release: { manifest: Pick<Release["manifest"], "migrationEvidence"> },
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
 * The failed samples of `app`'s `version` that still stand (as `failed`):
 * those no later sample of the same migration answered by finding
 * nothing left to transform, or by passing on at least as many records.
 * Nothing left means the backfill got through every record, each one it
 * wrote validated against the target, so no failure is left to show. A
 * smaller sample that passes may just have missed the failing record,
 * so it doesn't vouch for the larger one. Later is by rowid: receipts are
 * append-only (0103), so the order they were stored in, whatever two
 * samples' clocks said.
 */
const standingFailures = (app: AppId, version: number) =>
  sql`FROM migration_samples AS failed
    WHERE failed.app_id = ${app} AND failed.version = ${version}
      AND failed.outcome = 'failed'
      AND NOT EXISTS (SELECT 1 FROM migration_samples AS later
        WHERE later.app_id = failed.app_id AND later.version = failed.version
          AND later.migration = failed.migration AND later.rowid > failed.rowid
          AND (later.outcome = 'empty'
            OR (later.outcome = 'passed' AND later.rows >= failed.rows)))`;

/**
 * Holds while no failed sample of `app`'s `version` stands
 * (`standingFailures`), as the statement runs: the activation's own
 * check, so a sample that fails after `requireMigrationEvidence` read
 * none still keeps the version from being made current (apps.ts).
 */
export const noFailedSampleSql = (app: AppId, version: number): SQL =>
  sql`NOT EXISTS (SELECT 1 ${standingFailures(app, version)})`;

/**
 * The latest failed sample of `app`'s `version` that still stands
 * (`standingFailures`): its migration and its reason; undefined when
 * none does.
 */
export const failedSample = async (
  env: Env,
  app: AppId,
  version: number
): Promise<{ migration: string; reason: string | null } | undefined> => {
  const [failed] = await drizzle(env.DB).all<{
    migration: string;
    reason: string | null;
  }>(
    sql`SELECT failed.migration AS migration, failed.reason AS reason
      ${standingFailures(app, version)}
      ORDER BY failed.rowid DESC LIMIT 1`
  );
  return failed === undefined
    ? undefined
    : { migration: failed.migration, reason: failed.reason };
};

/**
 * Refuses making `version` of `app` current while any of its release's
 * migrations failed on its fixtures (`version.migration_fixtures_failed`)
 * or on its latest sample (`version.migration_sample_failed`).
 */
export const requireMigrationEvidence = async (
  env: Env,
  app: AppId,
  version: number
): Promise<void> => {
  // From its hash-checked manifest alone (`sealedEvidence`): the gate
  // loads none of its artifacts.
  const migrationEvidence = await sealedEvidence(env, app, version);
  const failed =
    migrationEvidence === undefined
      ? undefined
      : failedEvidence({ manifest: { migrationEvidence } });
  if (failed !== undefined) {
    throw fixturesFailedError(failed);
  }
  const sampled = await failedSample(env, app, version);
  if (sampled !== undefined) {
    throw versionErrors.create("version.migration_sample_failed", sampled);
  }
};
