import { versionErrors } from "@grasp-os/shared/app-releases";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  sdkArtifactCandidates,
  sdkArtifactDeletions,
  sdkReleaseArtifacts,
  sdkReleaseManifests,
  sdkReleasePins,
  sdkReleaseTombstones,
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
//   is kept while it is the App's current or pending version, for 90
//   days after it last was (stamped as it stops being current, apps.ts,
//   and by every sweep; or after its seal, if it never was), while an
//   open screen's lease on it holds (15 minutes from the last renewal),
//   while a workflow run of that version is active, while any pin holds
//   it (a run, a compatible migration, a pinned trigger, an admin's legal
//   hold), and once revoked, for good. Nothing App code does shortens
//   any of it.
// - A release becomes unreferenced and referenced again in between: the
//   sweep marks it first, deletes it only once the mark is a day old, and
//   deletes it in a statement that checks every reference again, so a
//   lease or a pin taken during the grace keeps it.
// - A deleted release's version comes back as other code: its manifest
//   hash is kept (`sdk_release_tombstones`), written in the transaction
//   that deletes it, and sealing that version again must make the same
//   manifest (app-releases.ts).
// - An artifact other releases share is deleted with one of them:
//   artifacts are content-addressed, so releases share bytes. Each seal
//   reserves the artifacts it names (`sdk_release_artifacts`) before it
//   stores them; bytes are deleted only once no reservation names them,
//   under a mark (`sdk_artifact_deletions`) placed in the same statement
//   that checks there is none, and a seal reserves only where there is no
//   mark (app-releases.ts). Only the mark's owner deletes the bytes, and
//   it removes the mark only once its delete is done; a seal that finds a
//   mark waits for it to go, then reserves and stores the bytes again. So
//   no late delete of a deletion in flight reaches bytes a seal wrote
//   after it.
// - A deleter stalls past the takeover (plain workerd has no wall-clock
//   cap): each mark has a deadline, 15 minutes after it was placed
//   (`markDeadlineMs`). The owner gives up if its own clock is past it
//   just before it deletes, and every await before that is cut off well
//   short of it (`deletionStepMs`). A mark is taken over only an hour
//   after it was placed (`markTakeoverMs`), long after its owner gave up.
//   What remains is one R2 delete already sent when the deadline passed,
//   which would have to stay in flight for the 45 minutes between the
//   deadline and a takeover.
// - Bytes are left behind: removing a release's or an unfinished seal's
//   reservation queues its bytes (`sdk_artifact_candidates`) in the same
//   statement, and a sweep dequeues each only once its bytes are dealt
//   with, page by page, so a sweep that stops or fails half-way leaves
//   the rest queued for the next.
// - Pins pile up: every screen leases its release over and over. A lapsed
//   lease is deleted by the next sweep, and a release's pins with it.
// - A release turns out to be dangerous: an admin of the organization
//   revokes it, and it runs no more (`version.revoked`, checked on every
//   load and every authorization of a call, so a call already running
//   commits nothing after it); it is kept, bytes and all, for audit and
//   recovery.
// - A demoted admin's session still revokes or holds: each write checks
//   that they are still an active admin, in its own statement.

/** How long an open screen's lease on its release lasts without renewal. */
export const frameLeaseMs = 15 * 60_000;

/** How long a release is kept after it was last current, at least. */
export const releaseRetentionMs = 90 * 24 * 60 * 60_000;

/** How long a release found unreferenced waits before it is deleted. */
export const releaseGraceMs = 24 * 60 * 60_000;

/**
 * How old a deletion mark must be before someone else takes it over: an
 * hour, longer than any invocation of core runs (a request's or a cron's
 * wall-clock limit is 15 minutes), so its owner has stopped for good.
 */
export const markTakeoverMs = 60 * 60_000;

/** How long a mark's owner may take to finish it, from when it was placed. */
export const markDeadlineMs = 15 * 60_000;

/** The longest any one step of a deletion may take before it gives up. */
const deletionStepMs = 60_000;

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
const referenced = (now: Date): SQL => {
  const retained = new Date(now.getTime() - releaseRetentionMs);
  return sql`(
    ${sdkReleaseManifests.revokedAt} IS NOT NULL
    OR EXISTS (SELECT 1 FROM apps WHERE apps.id = ${sdkReleaseManifests.appId}
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
 * migration, a trigger, an open screen), until `expiresAt` (a lease) or
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
 * once, with its manifest hash and why.
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
  const [revoked] = await auditedBatch(env, db, [
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
    outboxedIfChanged(
      db,
      releaseEntry(by, "app.release.revoked", key, {
        manifestHash: hash,
        reason: reason.slice(0, 500),
      })
    ),
  ]);
  if (revoked.length === 0) {
    // Revoked already, or `by` is no longer an admin: only that refuses.
    await requireStillAdmin(env, by);
  }
};

/**
 * Marks `sha256` for deletion, for a new owner, where no reservation
 * names it: a new mark, or one older than `markTakeoverMs`, taken over.
 * Placed at the real time, never a sweep's scheduled one, so its deadline
 * is truly 15 minutes off.
 * The owner, when this caller now owns the mark; undefined otherwise (the
 * bytes are reserved, or another live deleter owns the mark).
 */
export const markArtifact = async (
  env: Env,
  sha256: string
): Promise<string | undefined> => {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const marked = await env.DB.prepare(
    `INSERT INTO sdk_artifact_deletions (sha256, owner, started_at)
     SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM sdk_release_artifacts WHERE sha256 = ?1)
     ON CONFLICT (sha256) DO UPDATE SET owner = excluded.owner, started_at = excluded.started_at
       WHERE sdk_artifact_deletions.started_at < ?4
     RETURNING owner`
  )
    .bind(sha256, owner, now, now - markTakeoverMs)
    .all<{ owner: string }>();
  return marked.results[0]?.owner === owner ? owner : undefined;
};

/** `work`, or a failure once `ms` have passed without it settling. */
const within = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  const limit = deadline(ms);
  try {
    return await Promise.race([work, whenAborted(limit.signal)]);
  } finally {
    limit.clear();
  }
};

/**
 * Finishes the deletion `owner` marked: deletes the bytes while it still
 * owns the mark and its deadline hasn't passed by `clock`, then the mark,
 * only once the delete is done. True when the bytes are gone; false when
 * the mark is another's, or past its deadline (left to be taken over).
 */
export const finishDeletion = async (
  env: Env,
  sha256: string,
  owner: string,
  clock: () => number = Date.now
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const [mark] = await within(
    db
      .select({
        owner: sdkArtifactDeletions.owner,
        startedAt: sdkArtifactDeletions.startedAt,
      })
      .from(sdkArtifactDeletions)
      .where(eq(sdkArtifactDeletions.sha256, sha256)),
    deletionStepMs
  );
  if (mark?.owner !== owner) {
    return false;
  }
  // The fence: past its deadline, the mark may soon be another's.
  if (clock() > mark.startedAt.getTime() + markDeadlineMs) {
    log.warn("release.deletion_abandoned", { sha256 });
    return false;
  }
  await within(env.FILES.delete(`release-artifacts/${sha256}`), deletionStepMs);
  await within(
    db
      .delete(sdkArtifactDeletions)
      .where(
        and(
          eq(sdkArtifactDeletions.sha256, sha256),
          eq(sdkArtifactDeletions.owner, owner)
        )
      ),
    deletionStepMs
  );
  return true;
};

/**
 * Deletes the bytes of each of `hashes` no reservation names any more:
 * marks it, in the statement that checks there is none, deletes the
 * bytes, then the mark.
 */
export const deleteUnreservedArtifacts = async (
  env: Env,
  hashes: readonly string[]
): Promise<void> => {
  for (const sha256 of hashes) {
    // One after the other: each is a mark, a delete and an unmark; one
    // that fails leaves the rest to go on.
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const owner = await markArtifact(env, sha256);
      if (owner !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        await finishDeletion(env, sha256, owner);
      }
    } catch (error) {
      log.error("release.artifact_delete_failed", {
        sha256,
        ...errorFields(error),
      });
    }
  }
};

/**
 * Deals with the queued bytes (`sdk_artifact_candidates`), page by page,
 * at most `candidatePages` pages: each is dequeued once its bytes are
 * deleted, reserved again, or marked by another live deleter (theirs to
 * finish, or a takeover's). Bytes whose deletion failed or was abandoned
 * stay queued for the next sweep.
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
      })
      .from(sdkArtifactCandidates)
      .where(sql`${sdkArtifactCandidates.sha256} > ${after}`)
      .orderBy(sdkArtifactCandidates.sha256)
      .limit(candidatePage);
    for (const { sha256, queuedAt } of queued) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- see above
        const owner = await markArtifact(env, sha256);
        const dealt =
          owner === undefined ||
          // oxlint-disable-next-line no-await-in-loop -- see above
          (await finishDeletion(env, sha256, owner));
        if (dealt) {
          // Only as read: queued again since, it is the next sweep's.
          // oxlint-disable-next-line no-await-in-loop -- see above
          await db
            .delete(sdkArtifactCandidates)
            .where(
              and(
                eq(sdkArtifactCandidates.sha256, sha256),
                eq(sdkArtifactCandidates.queuedAt, queuedAt)
              )
            );
        }
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
 * Queues the bytes of the reservations `where` selects, to be dealt with,
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

/** Deletes one release found unreferenced a grace ago, if it still is. */
const deleteRelease = async (
  env: Env,
  key: ReleaseKey,
  now: Date
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const graceOver = new Date(now.getTime() - releaseGraceMs);
  /** That the release may go now: the statement that deletes it checks it. */
  const deletable = and(
    releaseIs(key),
    lt(sdkReleaseManifests.unreferencedSince, graceOver),
    sql`NOT ${referenced(now)}`
  );
  /** That the release's manifest row is gone: deleted by this batch. */
  const gone = sql`NOT EXISTS (SELECT 1 FROM sdk_release_manifests WHERE app_id = ${key.app} AND version = ${key.version})`;
  const [, [deleted]] = await db.batch([
    // Its hash first, in the same transaction, only if it may go.
    db
      .insert(sdkReleaseTombstones)
      .select(
        db
          .select({
            appId: sdkReleaseManifests.appId,
            version: sdkReleaseManifests.version,
            manifestHash: sdkReleaseManifests.manifestHash,
            deletedAt: sql<Date>`${now.getTime()}`.as("deleted_at"),
          })
          .from(sdkReleaseManifests)
          .where(deletable)
      )
      .onConflictDoUpdate({
        target: [sdkReleaseTombstones.appId, sdkReleaseTombstones.version],
        set: {
          manifestHash: sql`excluded.manifest_hash`,
          deletedAt: sql`excluded.deleted_at`,
        },
      }),
    db
      .delete(sdkReleaseManifests)
      .where(deletable)
      .returning({ appId: sdkReleaseManifests.appId }),
    db.delete(sdkResourceBindings).where(
      and(
        // A release's own store bindings: a workflow resource's bindings
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
    // Its bytes queued as their reservations go, in one transaction.
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
 * Removes the reservations of seals that never finished, a grace before
 * `now`, and queues their bytes, in one transaction: the sweep's step
 * before it deals with the queue.
 */
export const queueOrphanedReservations = async (
  env: Env,
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  const orphaned = and(
    lt(
      sdkReleaseArtifacts.reservedAt,
      new Date(now.getTime() - releaseGraceMs)
    ),
    sql`NOT EXISTS (SELECT 1 FROM sdk_release_manifests AS manifests
      WHERE manifests.app_id = ${sdkReleaseArtifacts.appId}
        AND manifests.version = ${sdkReleaseArtifacts.version})`,
    // Nor a JSON workflow version's sealed build (workflow-builds.ts):
    // versions are never deleted, so neither are the bytes they run.
    sql`NOT EXISTS (SELECT 1 FROM workflow_resource_versions AS versions
      WHERE versions.workflow_resource_id = ${sdkReleaseArtifacts.appId}
        AND versions.version = ${sdkReleaseArtifacts.version})`
  );
  await db.batch([
    queueReserved(db, orphaned),
    db.delete(sdkReleaseArtifacts).where(orphaned),
  ]);
};

/**
 * The retention sweep (see the header), from the cron: notes which
 * releases are current, deletes lapsed leases, marks releases nothing
 * keeps, unmarks those something keeps again, deletes those marked a
 * grace ago that still nothing keeps, with the bytes no other release
 * names, and finishes deletions whose deleter stopped and reservations of
 * seals that never finished.
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
    .delete(sdkReleasePins)
    .where(
      and(
        sql`${sdkReleasePins.expiresAt} IS NOT NULL`,
        sql`${sdkReleasePins.expiresAt} <= ${now.getTime()}`
      )
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
  // Deletions whose deleter stopped: taken over and finished.
  const stale = await db
    .select({ sha256: sdkArtifactDeletions.sha256 })
    .from(sdkArtifactDeletions)
    .where(
      // By the real time, as marks are placed by it.
      lt(sdkArtifactDeletions.startedAt, new Date(Date.now() - markTakeoverMs))
    )
    .limit(sweepBatch);
  await deleteUnreservedArtifacts(
    env,
    stale.map(({ sha256 }) => sha256)
  );
  await queueOrphanedReservations(env, now);
  await drainCandidates(env);
};
