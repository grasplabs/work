import { versionErrors } from "@grasp-os/shared/app-releases";
import { actorOf } from "@grasp-os/shared/audit";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  sdkArtifactDeletions,
  sdkReleaseArtifacts,
  sdkReleaseManifests,
  sdkReleasePins,
  sdkResourceBindings,
} from "./db/core/schema.ts";
import { requireMemberAdmin } from "./permissions.ts";

// How long a sealed release stays (spec 16.3), and how it is revoked.
// What could go wrong, and what stops it:
//
// - A release is deleted while something still runs on it, or might: it
//   is kept while it is the App's current or pending version, for 90
//   days after the sweep last saw it so (or after its seal, if it never
//   was), while an open screen's lease on it holds (15 minutes from the
//   last renewal), while a workflow run of that version is active, and
//   while any pin holds it (a run, a compatible migration, a pinned
//   trigger, a legal hold). Nothing App code does shortens any of it.
// - A release becomes unreferenced and referenced again in between: the
//   sweep marks it first, deletes it only once the mark is a day old, and
//   deletes it in a statement that checks every reference again, so a
//   lease or a pin taken during the grace keeps it.
// - An artifact other releases share is deleted with one of them:
//   artifacts are content-addressed, so releases share bytes. Each seal
//   reserves the artifacts it names (`sdk_release_artifacts`) before it
//   stores them; bytes are deleted only once no reservation names them,
//   under a mark (`sdk_artifact_deletions`) placed in the same statement
//   that checks there is none, and a seal reserves only where there is no
//   mark (app-releases.ts). So either the mark comes first, and the seal
//   waits for the bytes to be gone and stores them again, or the
//   reservation does, and the bytes stay.
// - A sweep stops half-way: what it marked for deletion is finished by
//   the next sweep, or by the seal that finds the mark.
// - A release turns out to be dangerous: an admin of the organization
//   revokes it, and it runs no more (`version.revoked`, checked on every
//   load); its bytes stay for audit and recovery.

/** How long an open screen's lease on its release lasts without renewal. */
export const frameLeaseMs = 15 * 60_000;

/** How long a release is kept after it was last current, at least. */
export const releaseRetentionMs = 90 * 24 * 60 * 60_000;

/** How long a release found unreferenced waits before it is deleted. */
export const releaseGraceMs = 24 * 60 * 60_000;

/** The most releases one sweep deletes. */
const sweepBatch = 20;

/** The run statuses that may still load their version's code. */
const activeRunStatuses = ["starting", "running", "paused"];

/** What may hold a release past its retention. */
export type PinHolder = (typeof sdkReleasePins.$inferInsert)["holderKind"];

/** What one release is, for the statements below. */
interface ReleaseKey {
  readonly app: AppId;
  readonly version: number;
}

/**
 * That the release `manifests` names is kept by something at `now`, as
 * SQL over its row (see the header).
 */
const referenced = (now: Date): SQL => {
  const retained = new Date(now.getTime() - releaseRetentionMs);
  return sql`(
    EXISTS (SELECT 1 FROM apps WHERE apps.id = ${sdkReleaseManifests.appId}
      AND (apps.current_version = ${sdkReleaseManifests.version}
        OR apps.pending_version = ${sdkReleaseManifests.version}))
    OR COALESCE(${sdkReleaseManifests.lastCurrentAt}, ${sdkReleaseManifests.sealedAt}) > ${retained.getTime()}
    OR EXISTS (SELECT 1 FROM sdk_release_pins AS pins
      WHERE pins.app_id = ${sdkReleaseManifests.appId}
        AND pins.version = ${sdkReleaseManifests.version}
        AND (pins.expires_at IS NULL OR pins.expires_at > ${now.getTime()}))
    OR EXISTS (SELECT 1 FROM workflow_runs AS runs
      WHERE runs.app_id = ${sdkReleaseManifests.appId}
        AND runs.version = ${sdkReleaseManifests.version}
        AND runs.status IN (${sql.join(
          activeRunStatuses.map((status) => sql`${status}`),
          sql`, `
        )}))
  )`;
};

/**
 * Pins release `key` for `holder`, until `expiresAt` (a lease) or until
 * it is unpinned. Pinning a release that isn't sealed is refused
 * (`version.not_sealed`): the pin must keep something.
 */
export const pinRelease = async (
  env: Env,
  key: ReleaseKey,
  holder: { kind: PinHolder; id: string },
  expiresAt: Date | null
): Promise<void> => {
  const pinned = await env.DB.prepare(
    `INSERT INTO sdk_release_pins (app_id, version, holder_kind, holder_id, expires_at, pinned_at)
     SELECT app_id, version, ?1, ?2, ?3, ?4 FROM sdk_release_manifests
     WHERE app_id = ?5 AND version = ?6
     ON CONFLICT (app_id, version, holder_kind, holder_id)
     DO UPDATE SET expires_at = excluded.expires_at
     RETURNING app_id`
  )
    .bind(
      holder.kind,
      holder.id,
      expiresAt?.getTime() ?? null,
      Date.now(),
      key.app,
      key.version
    )
    .all();
  if (pinned.results.length === 0) {
    throw versionErrors.create("version.not_sealed");
  }
};

/**
 * Leases release `key` for open screen `frame` from `now`: the lease
 * holds `frameLeaseMs` and is renewed by leasing again while the screen
 * stays connected (spec 16.3).
 */
export const leaseRelease = async (
  env: Env,
  key: ReleaseKey,
  frame: string,
  now = new Date()
): Promise<void> => {
  await pinRelease(
    env,
    key,
    { kind: "frame", id: frame },
    new Date(now.getTime() + frameLeaseMs)
  );
};

/** Releases `holder`'s pin on release `key`, if it has one. */
export const unpinRelease = async (
  env: Env,
  key: ReleaseKey,
  holder: { kind: PinHolder; id: string }
): Promise<void> => {
  await drizzle(env.DB)
    .delete(sdkReleasePins)
    .where(
      and(
        eq(sdkReleasePins.appId, key.app),
        eq(sdkReleasePins.version, key.version),
        eq(sdkReleasePins.holderKind, holder.kind),
        eq(sdkReleasePins.holderId, holder.id)
      )
    );
};

/**
 * Revokes release `key`, as an admin of the organization: it runs no
 * more, from the next load on (`version.revoked`), and its bytes stay.
 * Audited, with why.
 */
export const revokeRelease = async (
  env: Env,
  by: Identity & Pick<Acting, "actor">,
  key: ReleaseKey,
  reason: string
): Promise<void> => {
  requireMemberAdmin(by);
  const db = drizzle(env.DB);
  const [[revoked]] = await auditedBatch(env, db, [
    db
      .update(sdkReleaseManifests)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sdkReleaseManifests.appId, key.app),
          eq(sdkReleaseManifests.version, key.version),
          isNull(sdkReleaseManifests.revokedAt)
        )
      )
      .returning({ hash: sdkReleaseManifests.manifestHash }),
    outboxedIfChanged(db, {
      actor: by.actor ?? actorOf(by),
      action: "app.release.revoked",
      target: { type: "app", id: key.app },
      detail: { version: key.version, reason: reason.slice(0, 500) },
    }),
  ]);
  if (revoked === undefined) {
    const [row] = await db
      .select({ revokedAt: sdkReleaseManifests.revokedAt })
      .from(sdkReleaseManifests)
      .where(
        and(
          eq(sdkReleaseManifests.appId, key.app),
          eq(sdkReleaseManifests.version, key.version)
        )
      );
    if (row === undefined) {
      throw versionErrors.create("version.not_sealed");
    }
  }
};

/** Deletes a marked artifact's bytes, then its mark. */
export const finishDeletion = async (
  env: Env,
  sha256: string
): Promise<void> => {
  await env.FILES.delete(`release-artifacts/${sha256}`);
  await drizzle(env.DB)
    .delete(sdkArtifactDeletions)
    .where(eq(sdkArtifactDeletions.sha256, sha256));
};

/**
 * Deletes the bytes of each of `hashes` no reservation names any more:
 * marks it, in the statement that checks there is none, deletes the
 * bytes, then the mark. One already marked is finished here too.
 */
export const deleteUnreservedArtifacts = async (
  env: Env,
  hashes: readonly string[],
  now = new Date()
): Promise<void> => {
  for (const sha256 of hashes) {
    // One after the other: each is a mark, a delete and an unmark. The
    // mark goes in only where no reservation names the bytes; one there
    // already, an earlier deletion's, is finished too.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const marked = await env.DB.prepare(
      `INSERT INTO sdk_artifact_deletions (sha256, started_at)
       SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM sdk_release_artifacts WHERE sha256 = ?1)
       ON CONFLICT (sha256) DO UPDATE SET started_at = started_at
       RETURNING sha256`
    )
      .bind(sha256, now.getTime())
      .all();
    if (marked.results.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await finishDeletion(env, sha256);
    }
  }
};

/** Deletes one release found unreferenced a grace ago, if it still is. */
const deleteRelease = async (
  env: Env,
  key: ReleaseKey,
  now: Date
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const graceOver = new Date(now.getTime() - releaseGraceMs);
  const reserved = await db
    .select({ sha256: sdkReleaseArtifacts.sha256 })
    .from(sdkReleaseArtifacts)
    .where(
      and(
        eq(sdkReleaseArtifacts.appId, key.app),
        eq(sdkReleaseArtifacts.version, key.version)
      )
    );
  const [[deleted]] = await db.batch([
    db
      .delete(sdkReleaseManifests)
      .where(
        and(
          eq(sdkReleaseManifests.appId, key.app),
          eq(sdkReleaseManifests.version, key.version),
          lt(sdkReleaseManifests.unreferencedSince, graceOver),
          sql`NOT ${referenced(now)}`
        )
      )
      .returning({ appId: sdkReleaseManifests.appId }),
    db
      .delete(sdkResourceBindings)
      .where(
        and(
          eq(sdkResourceBindings.resourceId, key.app),
          eq(sdkResourceBindings.resourceVersion, key.version),
          sql`changes() > 0`
        )
      ),
    db
      .delete(sdkReleaseArtifacts)
      .where(
        and(
          eq(sdkReleaseArtifacts.appId, key.app),
          eq(sdkReleaseArtifacts.version, key.version),
          sql`NOT EXISTS (SELECT 1 FROM sdk_release_manifests WHERE app_id = ${key.app} AND version = ${key.version})`
        )
      ),
  ]);
  if (deleted === undefined) {
    return false;
  }
  await deleteUnreservedArtifacts(
    env,
    reserved.map(({ sha256 }) => sha256),
    now
  );
  return true;
};

/**
 * The retention sweep (see the header), from the cron: notes which
 * releases are current, marks those nothing keeps, unmarks those
 * something keeps again, deletes those marked a grace ago that still
 * nothing keeps, with the bytes no other release names, and finishes
 * deletions an earlier sweep left half-way and reservations of seals
 * that never finished.
 */
export const sweepReleases = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.DB);
  await db
    .update(sdkReleaseManifests)
    .set({ lastCurrentAt: now })
    .where(
      sql`EXISTS (SELECT 1 FROM apps WHERE apps.id = ${sdkReleaseManifests.appId}
        AND (apps.current_version = ${sdkReleaseManifests.version}
          OR apps.pending_version = ${sdkReleaseManifests.version}))`
    );
  await db
    .update(sdkReleaseManifests)
    .set({ unreferencedSince: null })
    .where(
      and(
        sql`${sdkReleaseManifests.unreferencedSince} IS NOT NULL`,
        referenced(now)
      )
    );
  await db
    .update(sdkReleaseManifests)
    .set({ unreferencedSince: now })
    .where(
      and(
        isNull(sdkReleaseManifests.unreferencedSince),
        sql`NOT ${referenced(now)}`
      )
    );
  const due = await db
    .select({
      app: sdkReleaseManifests.appId,
      version: sdkReleaseManifests.version,
    })
    .from(sdkReleaseManifests)
    .where(
      lt(
        sdkReleaseManifests.unreferencedSince,
        new Date(now.getTime() - releaseGraceMs)
      )
    )
    .limit(sweepBatch);
  for (const { app, version } of due) {
    try {
      // One after the other, each checked again as it is deleted.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const deleted = await deleteRelease(
        env,
        // SAFETY: an App ID, as the seal wrote it.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        { app: app as AppId, version },
        now
      );
      if (deleted) {
        log.info("release.deleted", { app, version });
      }
    } catch (error) {
      log.error("release.delete_failed", {
        app,
        version,
        ...errorFields(error),
      });
    }
  }
  // Deletions an earlier sweep marked and didn't finish.
  const marks = await db
    .select({ sha256: sdkArtifactDeletions.sha256 })
    .from(sdkArtifactDeletions)
    .limit(sweepBatch);
  for (const { sha256 } of marks) {
    // oxlint-disable-next-line no-await-in-loop -- see above
    await finishDeletion(env, sha256);
  }
  // Reservations of seals that never finished, a grace ago.
  const orphans = await db
    .delete(sdkReleaseArtifacts)
    .where(
      and(
        lt(
          sdkReleaseArtifacts.reservedAt,
          new Date(now.getTime() - releaseGraceMs)
        ),
        sql`NOT EXISTS (SELECT 1 FROM sdk_release_manifests AS manifests
          WHERE manifests.app_id = ${sdkReleaseArtifacts.appId}
            AND manifests.version = ${sdkReleaseArtifacts.version})`
      )
    )
    .returning({ sha256: sdkReleaseArtifacts.sha256 });
  await deleteUnreservedArtifacts(
    env,
    [...new Set(orphans.map(({ sha256 }) => sha256))].slice(0, 1024),
    now
  );
};
