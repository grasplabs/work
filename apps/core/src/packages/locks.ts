import { actorOf } from "@grasp-os/shared/audit";
import {
  dependencyErrors,
  dependencyTargetSchema,
} from "@grasp-os/shared/dependencies";
import type { DependencyTarget } from "@grasp-os/shared/dependencies";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  graspLockSchema,
  packageErrors,
  targetConfigHash,
} from "@grasp-os/shared/packages";
import type { GraspLock, PackageLimits } from "@grasp-os/shared/packages";
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { outboxed } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import {
  dependencyLocks,
  dependencyRequests,
  packageCleanups,
} from "../db/core/schema.ts";

// An App's locks as core stores them (`dependency_locks`), one per graph,
// and what keeps their number bounded. What could go wrong, and what
// stops it:
//
// - A lock without its request, or a request without its lock. The lock
//   is written in the batch that stores the request (`lockStatements`,
//   used by `proposeResolved`, dependencies/requests.ts), each write
//   conditional on the lock as it was read, with a guard that fails the
//   whole batch when the lock isn't the one written (`lockGuardFailed`):
//   the proposal then starts over.
// - Locks piling up. One that no pending or approved request names is
//   deleted in the batch that supersedes or denies a request
//   (`unusedLockStatements`). An App holds at most `packageLimits.appLocks`:
//   a new lock takes the room of the oldest approval no longer in use (not
//   pending, nor the latest for its targets, nor read through an artifact
//   address that still holds: `stale`), in the batch that stores it, so
//   changing graphs again and again never locks an App out for longer
//   than an address holds (about 12 hours). Only locks in use count
//   against the limit (`package.quota`), checked again in the statement
//   that inserts one, so two resolves can't both pass a check made before.
// - A page losing its files to another graph's resolve. An artifact's
//   address holds for hours (address.ts), and serve.ts serves only what
//   the lock still pins: a lock gives up its room only once every address
//   of its artifacts handed out has expired, recorded on the lock before
//   each is handed out (`holdLockFor`). Those locks count against the
//   limit like any in use, so it still holds.
// - Files no lock names any more. Each tarball and pinned artifact of a
//   deleted lock is recorded for cleanup in the same batch
//   (`package_cleanups`), and the cron deletes what no lock names by then
//   (cleanup.ts).

/**
 * The lock kept for a graph once `fresh` is added to it, and the targets
 * whose config (conditions and entries) it changes. The packages are the
 * graph's, the same whichever resolve named them (the graph's hash covers
 * every version, integrity and edge): the first lock's ranges and times
 * stay as its provenance. Targets aren't part of the graph's hash, so
 * each resolve sets the targets it asks for; the others stay as they
 * were. Every pin stays too: each is keyed by the config it was built for
 * (`targetConfigHash`), so a target set to another config is built anew
 * under its own pin, and one set back gets its old pin's bytes again.
 */
export const mergedLock = (
  existing: GraspLock,
  fresh: GraspLock
): { lock: GraspLock; changed: DependencyTarget[] } => {
  const changed = dependencyTargetSchema.options.filter((target) => {
    const before = existing.targets[target];
    const now = fresh.targets[target];
    return (
      before !== undefined &&
      now !== undefined &&
      canonicalJson(before) !== canonicalJson(now)
    );
  });
  return {
    lock: { ...existing, targets: { ...existing.targets, ...fresh.targets } },
    changed,
  };
};

/**
 * Each of `targets`' config hash in `lock`, as audit detail under
 * `<side>.<target>` (null for a target the lock has no config for): one
 * member each, so every target changing still fits.
 */
const configsOf = async (
  lock: GraspLock,
  targets: readonly DependencyTarget[],
  side: "from" | "to"
): Promise<Record<string, string | null>> =>
  Object.fromEntries(
    await Promise.all(
      targets.map(async (target) => {
        const config = lock.targets[target];
        return [
          `${side}.${target}`,
          config === undefined ? null : await targetConfigHash(target, config),
        ] as const;
      })
    )
  );

/** Where a guard that fails says so: the lock column, left empty. */
const guardFailure = "NOT NULL constraint failed: dependency_locks.lock";

/**
 * Whether a batch failed on a lock's guard (`lockStatements`): the lock
 * was other than the one written, or wasn't there, as the batch ran.
 */
export const lockGuardFailed = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes(guardFailure) || lockGuardFailed(error.cause));

/** That no pending or approved request of its App names the lock `lock`. */
const unused = (lock: string): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM ${dependencyRequests} WHERE ${dependencyRequests.appId} = ${sql.raw(lock)}.app_id AND ${dependencyRequests.graphHash} = ${sql.raw(lock)}.graph_hash AND ${dependencyRequests.status} IN ('pending', 'approved'))`;

/**
 * That the lock `lock` is no longer in use: neither the App's pending
 * request names it, nor its latest approval for any set of targets, and
 * no address of one of its artifacts handed out still holds
 * (`holdLockFor`). An approval never ends (until GRA-359), so an App that
 * changes its graph again and again keeps older approvals; their locks
 * are what a new one may take the room of, once nothing handed out reads
 * them any more. A resolve back to such a graph finds its approval
 * standing, and writes its lock again.
 */
const stale = (lock: string): SQL =>
  sql`(COALESCE(${sql.raw(lock)}.served_until, 0) <= ${Date.now()} AND NOT EXISTS (SELECT 1 FROM dependency_requests r WHERE r.app_id = ${sql.raw(lock)}.app_id AND r.graph_hash = ${sql.raw(lock)}.graph_hash AND (r.status = 'pending' OR (r.status = 'approved' AND NOT EXISTS (SELECT 1 FROM dependency_requests n WHERE n.app_id = r.app_id AND n.status = 'approved' AND n.targets = r.targets AND n.decided_at > r.decided_at)))))`;

/**
 * That the lock `lock` is one a new lock of `app` takes the room of, as
 * the statement runs: of its stale locks, the oldest by when they were
 * last approved, as many as the App holds past `cap` with the new one.
 */
const evicted = (lock: string, app: string, cap: number): SQL =>
  sql`${sql.raw(lock)}.graph_hash IN (SELECT e.graph_hash FROM dependency_locks e WHERE e.app_id = ${app} AND ${stale("e")} ORDER BY (SELECT MAX(a.decided_at) FROM dependency_requests a WHERE a.app_id = e.app_id AND a.graph_hash = e.graph_hash AND a.status = 'approved') ASC LIMIT MAX(0, (SELECT COUNT(*) FROM dependency_locks c WHERE c.app_id = ${app}) - ${cap} + 1))`;

/**
 * The statements that delete each of `app`'s locks `which` selects (by an
 * alias it is given), after recording each tarball and pinned artifact it
 * named for cleanup (cleanup.ts): what another lock still names is kept.
 */
const forgetLocks = (
  db: DrizzleD1Database,
  app: string,
  which: (lock: string) => SQL
) => {
  const now = Date.now();
  return [
    db
      .insert(packageCleanups)
      .select(
        sql`SELECT json_extract(p.value, '$.integrity'), 'tarball', ${now} FROM ${dependencyLocks} l, json_each(l.lock, '$.packages') p WHERE l.app_id = ${app} AND ${which("l")}`
      )
      .onConflictDoUpdate({
        target: packageCleanups.key,
        set: { createdAt: sql`excluded.created_at` },
      }),
    db
      .insert(packageCleanups)
      .select(
        sql`SELECT json_extract(pin.value, '$.hash'), 'build', ${now} FROM ${dependencyLocks} l, json_each(l.lock, '$.artifacts') c, json_each(c.value) pin WHERE l.app_id = ${app} AND ${which("l")}`
      )
      .onConflictDoUpdate({
        target: packageCleanups.key,
        set: { createdAt: sql`excluded.created_at` },
      }),
    db
      .delete(dependencyLocks)
      .where(and(eq(dependencyLocks.appId, app), which("dependency_locks"))),
  ] as const;
};

/** What `lockStatements` read and worked out, for a batch to write. */
export interface LockWrite {
  /** The lock that holds once the batch lands. */
  lock: GraspLock;
  /** Its write, its audit event, and the guard: first in the batch. */
  statements: SQLiteBatchItem[];
}

/** A statement a drizzle D1 batch takes. */
type SQLiteBatchItem = Parameters<DrizzleD1Database["batch"]>[0][number];

/**
 * The statements that store `fresh` as the lock of `app`'s graph, or add
 * its targets to the one stored, as part of a batch: an insert, after
 * the locks of older approvals give up their room, held to the App's
 * `appLocks` as it runs; or an update, only while the lock is
 * the text read, with a target whose config changes audited
 * (`dependency.lock_targets_changed`); then a guard that fails the batch
 * unless the lock is the one written (`lockGuardFailed`). A new lock past
 * the limit is refused here with `package.quota`; one the limit refused
 * only as the batch ran fails its guard, and the next attempt says so.
 */
export const lockStatements = async (
  db: DrizzleD1Database,
  by: Acting,
  {
    app,
    graphHash,
    fresh,
    limits,
  }: { app: string; graphHash: string; fresh: GraspLock; limits: PackageLimits }
): Promise<LockWrite> => {
  const where = and(
    eq(dependencyLocks.appId, app),
    eq(dependencyLocks.graphHash, graphHash)
  );
  const row = await db
    .select({ lock: dependencyLocks.lock })
    .from(dependencyLocks)
    .where(where)
    .get();
  const before = row ? graspLockSchema.parse(JSON.parse(row.lock)) : undefined;
  const merged = before
    ? mergedLock(before, fresh)
    : { lock: fresh, changed: [] };
  const stored = canonicalJson(graspLockSchema.parse(merged.lock));
  if (new TextEncoder().encode(stored).byteLength > limits.lockBytes) {
    throw packageErrors.create("package.quota", {
      quota: "lockBytes",
      limit: limits.lockBytes,
    });
  }
  // Inserts a row with no lock, which the column refuses, unless the lock
  // is the one written: a batch with it lands only with that lock.
  const guard = db
    .insert(dependencyLocks)
    .select(
      sql`SELECT ${app}, ${graphHash}, NULL, 0, NULL WHERE NOT EXISTS (SELECT 1 FROM ${dependencyLocks} WHERE ${where} AND ${dependencyLocks.lock} = ${stored})`
    );
  if (row === undefined) {
    const live = await db
      .select({ locks: count() })
      .from(dependencyLocks)
      .where(
        and(
          eq(dependencyLocks.appId, app),
          sql`NOT ${stale("dependency_locks")}`
        )
      )
      .get();
    if ((live?.locks ?? 0) >= limits.appLocks) {
      throw packageErrors.create("package.quota", {
        quota: "appLocks",
        limit: limits.appLocks,
      });
    }
    return {
      lock: merged.lock,
      statements: [
        // Room first: the oldest approvals no longer in use give up theirs.
        ...forgetLocks(db, app, (lock) => evicted(lock, app, limits.appLocks)),
        db
          .insert(dependencyLocks)
          .select(
            sql`SELECT ${app}, ${graphHash}, ${stored}, ${Date.now()}, NULL WHERE (SELECT COUNT(*) FROM ${dependencyLocks} WHERE ${dependencyLocks.appId} = ${app}) < ${limits.appLocks}`
          )
          .onConflictDoNothing(),
        guard,
      ],
    };
  }
  if (row.lock === stored || before === undefined) {
    return { lock: merged.lock, statements: [guard] };
  }
  const update = db
    .update(dependencyLocks)
    .set({ lock: stored })
    .where(and(where, eq(dependencyLocks.lock, row.lock)));
  if (merged.changed.length === 0) {
    return { lock: merged.lock, statements: [update, guard] };
  }
  const [from, to] = await Promise.all([
    configsOf(before, merged.changed, "from"),
    configsOf(merged.lock, merged.changed, "to"),
  ]);
  return {
    lock: merged.lock,
    statements: [
      update,
      guard,
      // Only if the guard passed: the batch lands whole or not at all.
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "dependency.lock_targets_changed",
        target: { type: "app", id: app },
        detail: {
          app,
          graphHash,
          targets: merged.changed.join(" "),
          ...from,
          ...to,
        },
      }),
    ],
  };
};

/**
 * The statements, for the end of a batch that supersedes or denies one of
 * `app`'s requests, that delete each of its locks no pending or approved
 * request names any more, recording their files for cleanup.
 */
export const unusedLockStatements = (db: DrizzleD1Database, app: string) =>
  forgetLocks(db, app, unused);

/**
 * Records on `app`'s lock of `graphHash` that an address of one of its
 * artifacts holds until `until`, before the address is handed out: until
 * then the lock keeps its room (`stale`). It writes only when it moves
 * the time on, so about once a window; the read in the same batch says
 * whether the lock holds that long. A lock gone (another resolve took its
 * room as this ran) is refused as one never resolved: its address would
 * serve nothing.
 */
export const holdLockFor = async (
  env: Env,
  { app, graphHash, until }: { app: string; graphHash: string; until: number }
): Promise<void> => {
  const db = drizzle(env.DB);
  const where = and(
    eq(dependencyLocks.appId, app),
    eq(dependencyLocks.graphHash, graphHash)
  );
  const [, held] = await db.batch([
    db
      .update(dependencyLocks)
      .set({ servedUntil: new Date(until) })
      .where(
        and(where, sql`COALESCE(${dependencyLocks.servedUntil}, 0) < ${until}`)
      ),
    db
      .select({ app: dependencyLocks.appId })
      .from(dependencyLocks)
      .where(and(where, gte(dependencyLocks.servedUntil, new Date(until)))),
  ]);
  if (held.length === 0) {
    throw dependencyErrors.create("dependency.invalid", {
      issues: [
        "graphHash: no lock for this graph: resolve the dependencies first",
      ],
    });
  }
};
