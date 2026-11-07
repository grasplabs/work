import { versionErrors } from "@grasp-os/shared/app-releases";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { revocationsOf, tellKept } from "./access-revocations.ts";
import { artifactKey } from "./app-releases.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  outboxedIfChanged,
  storedEvent,
} from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  appVersions,
  apps,
  sdkArtifactCandidates,
  sdkReleaseArtifacts,
  sdkReleaseManifests,
  sdkReleasePins,
  sdkResourceBindings,
} from "./db/core/schema.ts";
import {
  requireMemberAdmin,
  requireStillAdmin,
  stillAdminSql,
} from "./permissions.ts";

// How long a sealed release stays (spec 16.3), and how it is revoked.
// What could go wrong, and what stops it:
//
// - A release is deleted while something still runs on it, or might: it
//   is kept while it is the App's current or pending version, while it is
//   one of the App's last `keptReleases` releases (a rollback's), for a
//   day after its seal (a publish under way), while an open page's lease
//   on it holds (15 minutes from the last renewal), while a workflow run
//   of that version is active, while any pin holds it (a run, a
//   compatible migration, a pinned trigger, an admin's legal hold), and
//   once revoked, for good. Nothing App code does shortens any of it.
// - A release is referenced again as it goes: the statement that deletes
//   it checks every reference again, and a pin or a lease needs the
//   release's row, so one is either taken first and keeps it, or refused.
// - A deleted release's version is made current untested: deleting it
//   clears its version's `published` status in the same transaction, so
//   it runs again only once published again, sealed anew and tested
//   (app-publish.ts).
// - A revoked release comes back: it is kept for good, so its version can
//   neither be sealed again nor made current (`version.revoked`).
// - An artifact other releases share is deleted with one of them:
//   artifacts are content-addressed, so releases share bytes. Each seal
//   references the artifacts it names (`sdk_release_artifacts`) before it
//   stores them, and bytes are deleted only once no reference names them.
//   A reference written in the moment between that check and the delete
//   loses its bytes; such a release is refused as it is made current,
//   which reads every byte back (`makeCurrent`), so it never runs.
// - Bytes are left behind: removing a release's or an unfinished seal's
//   references queues its bytes (`sdk_artifact_candidates`) in the same
//   statement, and a sweep dequeues each only once its bytes are dealt
//   with, page by page, so a sweep that stops or fails half-way leaves the
//   rest queued for the next.
// - Pins pile up: every page leases its release over and over. A lapsed
//   lease is deleted by the next sweep, and a release's pins with it.
// - A release turns out to be dangerous: an admin of the organization
//   revokes it, and it runs no more (`version.revoked`, checked on every
//   load and every authorization of a call, so a call already running
//   commits nothing after it); it is kept, bytes and all, for audit and
//   recovery.
// - A demoted admin's session still revokes or holds: each write checks
//   that they are still an active admin, in its own statement.

/** How long an open page's lease on its release lasts without renewal. */
export const frameLeaseMs = 15 * 60_000;

/** How many of an App's latest releases are kept, to roll back to. */
export const keptReleases = 10;

/**
 * How long a seal may take: a release is kept this long after it was
 * sealed, and a seal's references this long while no release names them.
 */
export const sealGraceMs = 24 * 60 * 60_000;

/** Queued bytes one page of a sweep deals with, and the pages per sweep. */
export const candidatePage = 100;
const candidatePages = 10;

/** The most releases one sweep deletes. */
const sweepBatch = 20;

/** The run statuses that may still load their version's code. */
const activeRunStatuses = ["starting", "running", "paused"];

/** What may hold a release past its retention, besides an admin's hold. */
export type PinHolder = Exclude<
  (typeof sdkReleasePins.$inferInsert)["holderKind"],
  "hold"
>;

/** What one release is, for the statements below. */
interface ReleaseKey {
  readonly app: AppId;
  readonly version: number;
}

/** Who acts as an admin here: their session, and how the log names them. */
type Admin = Identity & Pick<Acting, "actor">;

/**
 * That the release `manifests` names is kept by something at `now`, as
 * SQL over its row (see the header).
 */
const referenced = (now: Date): SQL =>
  sql`(
    ${sdkReleaseManifests.revokedAt} IS NOT NULL
    OR ${sdkReleaseManifests.sealedAt} > ${now.getTime() - sealGraceMs}
    OR EXISTS (SELECT 1 FROM apps WHERE apps.id = ${sdkReleaseManifests.appId}
      AND (apps.current_version = ${sdkReleaseManifests.version}
        OR apps.pending_version = ${sdkReleaseManifests.version}))
    OR (SELECT COUNT(*) FROM sdk_release_manifests AS newer
      WHERE newer.app_id = ${sdkReleaseManifests.appId}
        AND newer.version > ${sdkReleaseManifests.version}) < ${keptReleases}
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

/** The row of release `key`. */
const releaseIs = (key: ReleaseKey): SQL | undefined =>
  and(
    eq(sdkReleaseManifests.appId, key.app),
    eq(sdkReleaseManifests.version, key.version)
  );

/** The manifest hash of release `key`, or `version.not_sealed`. */
const sealedHash = async (env: Env, key: ReleaseKey): Promise<string> => {
  const [row] = await drizzle(env.DB)
    .select({ hash: sdkReleaseManifests.manifestHash })
    .from(sdkReleaseManifests)
    .where(releaseIs(key));
  if (row === undefined) {
    throw versionErrors.create("version.not_sealed");
  }
  return row.hash;
};

/**
 * Pins release `key` for `holder`, the platform's own (a run, a
 * migration, a trigger, an open page), until `expiresAt` (a lease) or
 * until it is unpinned. Pinning a release that isn't sealed is refused
 * (`version.not_sealed`): the pin must keep something. A legal hold is
 * an admin's (`placeHold`), never placed here.
 */
export const pinRelease = async (
  env: Env,
  key: ReleaseKey,
  holder: { kind: PinHolder; id: string },
  expiresAt: Date | null
): Promise<void> => {
  const kind: string = holder.kind;
  // The type says so; this holds for callers that typed around it.
  if (kind === "hold") {
    throw new Error("A legal hold is placed by an admin, with placeHold");
  }
  const pinned = await env.DB.prepare(
    `INSERT INTO sdk_release_pins (app_id, version, holder_kind, holder_id, expires_at, pinned_at)
     SELECT app_id, version, ?1, ?2, ?3, ?4 FROM sdk_release_manifests
     WHERE app_id = ?5 AND version = ?6
     ON CONFLICT (app_id, version, holder_kind, holder_id)
     DO UPDATE SET expires_at = excluded.expires_at
     RETURNING app_id`
  )
    .bind(
      kind,
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
 * Leases release `key` for open page `frame` from `now`: the lease
 * holds `frameLeaseMs` and is renewed by leasing again while the page
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
  const kind: string = holder.kind;
  // As for pinRelease: a hold is released by an admin, with releaseHold.
  if (kind === "hold") {
    throw new Error("A legal hold is released by an admin, with releaseHold");
  }
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

/** An audit entry of an admin's act on release `key`. */
const releaseEntry = (
  by: Admin,
  action: string,
  key: ReleaseKey,
  detail: Record<string, string | number>
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: "app", id: key.app },
  detail: { version: key.version, ...detail },
});

/**
 * Places legal hold `hold` on release `key`, as an admin of the
 * organization: kept until the hold is released, with no expiry anything
 * could shorten. Audited, with why; placing it again changes nothing.
 */
export const placeHold = async (
  env: Env,
  by: Admin,
  key: ReleaseKey,
  hold: string,
  reason: string
): Promise<void> => {
  requireMemberAdmin(by);
  const hash = await sealedHash(env, key);
  const db = drizzle(env.DB);
  const [held] = await auditedBatch(env, db, [
    db
      .insert(sdkReleasePins)
      .select(
        db
          .select({
            appId: sdkReleaseManifests.appId,
            version: sdkReleaseManifests.version,
            holderKind: sql<"hold">`'hold'`.as("holder_kind"),
            holderId: sql<string>`${hold}`.as("holder_id"),
            expiresAt: sql<Date | null>`NULL`.as("expires_at"),
            pinnedAt: sql<Date>`${Date.now()}`.as("pinned_at"),
          })
          .from(sdkReleaseManifests)
          .where(and(releaseIs(key), stillAdminSql(by)))
      )
      .onConflictDoNothing()
      .returning({ appId: sdkReleasePins.appId }),
    outboxedIfChanged(
      db,
      releaseEntry(by, "app.release.held", key, {
        hold,
        manifestHash: hash,
        reason: reason.slice(0, 500),
      })
    ),
  ]);
  if (held.length === 0) {
    // Held already, or `by` is no longer an admin: only that refuses.
    await requireStillAdmin(env, by);
  }
};

/** Releases legal hold `hold` on release `key`, as an admin. Audited. */
export const releaseHold = async (
  env: Env,
  by: Admin,
  key: ReleaseKey,
  hold: string
): Promise<void> => {
  requireMemberAdmin(by);
  const db = drizzle(env.DB);
  const [released] = await auditedBatch(env, db, [
    db
      .delete(sdkReleasePins)
      .where(
        and(
          eq(sdkReleasePins.appId, key.app),
          eq(sdkReleasePins.version, key.version),
          eq(sdkReleasePins.holderKind, "hold"),
          eq(sdkReleasePins.holderId, hold),
          stillAdminSql(by)
        )
      )
      .returning({ appId: sdkReleasePins.appId }),
    outboxedIfChanged(
      db,
      releaseEntry(by, "app.release.hold_released", key, { hold })
    ),
  ]);
  if (released.length === 0) {
    await requireStillAdmin(env, by);
  }
};

/**
 * Revokes release `key`, as an admin of the organization: it runs no
 * more, from the next load and the next authorization of a call already
 * running (`version.revoked`), and it is kept, bytes and all. Audited
 * once, with its manifest hash and why. Its App's open pages are told
 * to look again (access-revocations.ts), so a live query of a build of it
 * ends now, not at the App's next change.
 */
export const revokeRelease = async (
  env: Env,
  by: Admin,
  key: ReleaseKey,
  reason: string
): Promise<void> => {
  requireMemberAdmin(by);
  const hash = await sealedHash(env, key);
  const db = drizzle(env.DB);
  const event = createAuditEvent(
    releaseEntry(by, "app.release.revoked", key, {
      manifestHash: hash,
      reason: reason.slice(0, 500),
    }),
    "core"
  );
  const [revoked, , kept] = await auditedBatch(env, db, [
    db
      .update(sdkReleaseManifests)
      .set({ revokedAt: new Date() })
      .where(
        and(
          releaseIs(key),
          isNull(sdkReleaseManifests.revokedAt),
          stillAdminSql(by)
        )
      )
      .returning({ hash: sdkReleaseManifests.manifestHash }),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    // Only when it was recorded, so only when it landed.
    revocationsOf(db, eq(apps.id, key.app), null, storedEvent(event.id)),
  ]);
  await tellKept(env, kept);
  if (revoked.length === 0) {
    // Revoked already, or `by` is no longer an admin: only that refuses.
    await requireStillAdmin(env, by);
  }
};

/** `work`, or a failure once `ms` have passed without it settling. */
export const within = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  const limit = deadline(ms);
  try {
    return await Promise.race([work, whenAborted(limit.signal)]);
  } finally {
    limit.clear();
  }
};

/**
 * Deals with the queued bytes (`sdk_artifact_candidates`), page by page,
 * at most `candidatePages` pages: each nothing references any more is
 * deleted, and each is dequeued once dealt with (deleted, or referenced
 * again: shared, so never deleted). Bytes whose deletion failed stay
 * queued for the next sweep.
 */
const drainCandidates = async (env: Env): Promise<void> => {
  const db = drizzle(env.DB);
  let after = "";
  for (let page = 0; page < candidatePages; page += 1) {
    // Pages one after the other, by hash, so none is skipped.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const queued = await db
      .select({
        sha256: sdkArtifactCandidates.sha256,
        queuedAt: sdkArtifactCandidates.queuedAt,
        referenced: sql<number>`EXISTS (SELECT 1 FROM sdk_release_artifacts AS refs
          WHERE refs.sha256 = sdk_artifact_candidates.sha256)`,
      })
      .from(sdkArtifactCandidates)
      .where(sql`${sdkArtifactCandidates.sha256} > ${after}`)
      .orderBy(sdkArtifactCandidates.sha256)
      .limit(candidatePage);
    for (const { sha256, queuedAt, referenced: shared } of queued) {
      try {
        if (shared === 0) {
          // oxlint-disable-next-line no-await-in-loop -- one after the other
          await env.FILES.delete(artifactKey(sha256));
        }
        // Only as read: queued again since, it is the next sweep's.
        // oxlint-disable-next-line no-await-in-loop -- as above
        await db
          .delete(sdkArtifactCandidates)
          .where(
            and(
              eq(sdkArtifactCandidates.sha256, sha256),
              eq(sdkArtifactCandidates.queuedAt, queuedAt)
            )
          );
      } catch (error) {
        log.error("release.artifact_delete_failed", {
          sha256,
          ...errorFields(error),
        });
      }
    }
    const last = queued.at(-1);
    if (last === undefined || queued.length < candidatePage) {
      return;
    }
    after = last.sha256;
  }
};

/**
 * Queues the bytes of the references `where` selects, to be dealt with,
 * at the real time: queued again, an entry's time is renewed, so a drain
 * that read it before dequeues it no more.
 */
const queueReserved = (
  db: ReturnType<typeof drizzle>,
  where: SQL | undefined
) =>
  db
    .insert(sdkArtifactCandidates)
    .select(
      db
        .selectDistinct({
          sha256: sdkReleaseArtifacts.sha256,
          queuedAt: sql<Date>`${Date.now()}`.as("queued_at"),
        })
        .from(sdkReleaseArtifacts)
        .where(where)
    )
    .onConflictDoUpdate({
      target: sdkArtifactCandidates.sha256,
      set: { queuedAt: sql`excluded.queued_at` },
    });

/**
 * Removes the references `where` matches and queues their bytes, in one
 * transaction, for a seal that won't name them after all (a JSON
 * workflow's publication that lost its race, workflow-builds.ts): the
 * sweep deletes bytes nothing else references.
 */
export const releaseReservations = async (
  env: Env,
  where: SQL
): Promise<void> => {
  const db = drizzle(env.DB);
  await db.batch([
    queueReserved(db, where),
    db.delete(sdkReleaseArtifacts).where(where),
  ]);
};

/**
 * Deletes release `key` if nothing keeps it at `now`, in the statement
 * that checks it, with its bindings, pins and references (its bytes
 * queued), and its version's `published` status, in one transaction.
 * Whether it was deleted.
 */
const deleteRelease = async (
  env: Env,
  key: ReleaseKey,
  now: Date
): Promise<boolean> => {
  const db = drizzle(env.DB);
  /** That the release's manifest row is gone: deleted by this batch. */
  const gone = sql`NOT EXISTS (SELECT 1 FROM sdk_release_manifests WHERE app_id = ${key.app} AND version = ${key.version})`;
  const [[deleted]] = await db.batch([
    db
      .delete(sdkReleaseManifests)
      .where(and(releaseIs(key), sql`NOT ${referenced(now)}`))
      .returning({ appId: sdkReleaseManifests.appId }),
    db.delete(sdkResourceBindings).where(
      and(
        // A release's own store binding: a workflow resource's bindings
        // (workflow-resources.ts) are never an App release's.
        eq(sdkResourceBindings.kind, "store"),
        eq(sdkResourceBindings.resourceId, key.app),
        eq(sdkResourceBindings.resourceVersion, key.version),
        gone
      )
    ),
    db
      .delete(sdkReleasePins)
      .where(
        and(
          eq(sdkReleasePins.appId, key.app),
          eq(sdkReleasePins.version, key.version),
          gone
        )
      ),
    // Its version runs again only once published again: sealed anew and
    // its tests run on what was sealed (app-publish.ts).
    db
      .update(appVersions)
      .set({ status: null })
      .where(
        and(
          eq(appVersions.appId, key.app),
          eq(appVersions.version, key.version),
          gone
        )
      ),
    // Its bytes queued as its references go, in one transaction.
    queueReserved(
      db,
      and(
        eq(sdkReleaseArtifacts.appId, key.app),
        eq(sdkReleaseArtifacts.version, key.version),
        gone
      )
    ),
    db
      .delete(sdkReleaseArtifacts)
      .where(
        and(
          eq(sdkReleaseArtifacts.appId, key.app),
          eq(sdkReleaseArtifacts.version, key.version),
          gone
        )
      ),
  ]);
  return deleted !== undefined;
};

/**
 * Removes the references of seals that never finished, a day before
 * `now`, and queues their bytes, in one transaction: the sweep's step
 * before it deals with the queue.
 */
export const queueOrphanedReservations = async (
  env: Env,
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  const orphaned = and(
    lt(sdkReleaseArtifacts.reservedAt, new Date(now.getTime() - sealGraceMs)),
    sql`NOT EXISTS (SELECT 1 FROM sdk_release_manifests AS manifests
      WHERE manifests.app_id = ${sdkReleaseArtifacts.appId}
        AND manifests.version = ${sdkReleaseArtifacts.version})`,
    // Nor a JSON workflow version's sealed build (workflow-builds.ts):
    // versions are never deleted, so neither are the bytes they run.
    sql`NOT EXISTS (SELECT 1 FROM workflow_resource_versions AS versions
      WHERE versions.workflow_resource_id = ${sdkReleaseArtifacts.appId}
        AND versions.version = ${sdkReleaseArtifacts.version})`,
    // Nor a test run's build while its row is kept
    // (workflows/candidate-runs.ts): the sweep of test runs deletes the
    // row, and with it what keeps the reference.
    sql`NOT EXISTS (SELECT 1 FROM workflow_candidate_runs AS candidates
      WHERE candidates.reservation = ${sdkReleaseArtifacts.appId})`
  );
  await db.batch([
    queueReserved(db, orphaned),
    db.delete(sdkReleaseArtifacts).where(orphaned),
  ]);
};

/**
 * The retention sweep (see the header), from the clock: deletes lapsed
 * leases, then the releases nothing keeps, each checked again as it is
 * deleted, with the bytes nothing else references, and the references of
 * seals that never finished.
 */
export const sweepReleases = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.DB);
  await db
    .delete(sdkReleasePins)
    .where(
      and(
        sql`${sdkReleasePins.expiresAt} IS NOT NULL`,
        sql`${sdkReleasePins.expiresAt} <= ${now.getTime()}`
      )
    );
  const due = await db
    .select({
      app: sdkReleaseManifests.appId,
      version: sdkReleaseManifests.version,
    })
    .from(sdkReleaseManifests)
    .where(sql`NOT ${referenced(now)}`)
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
  await queueOrphanedReservations(env, now);
  await drainCandidates(env);
};
