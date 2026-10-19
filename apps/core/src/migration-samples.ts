import { actorOf } from "@grasp-os/shared/audit";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import { requireAdmin } from "@grasp-os/shared/roles";
import {
  dataErrors,
  migrationErrors,
  migrationSampleRows,
  sampleMigrationSchema,
} from "@grasp-os/shared/stores";
import type { MigrationSample } from "@grasp-os/shared/stores";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "./app-releases.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import type { Member } from "./auth/identity.ts";
import { migrationSampleLeases, migrationSamples } from "./db/core/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { transformBatch } from "./migration-transform.ts";
import type { TransformFailure } from "./migration-transform.ts";
import { requireNotStaff } from "./sharing.ts";

// An explicit migration's dry run on a sample of the real records it
// would transform (spec 17.2's "read-only sampled production projection
// according to authorized data policy", GRA-545): the second half of its
// evidence, beside the fixtures its release was sealed with
// (migration-transform.ts, `migrationEvidence`). Sample data is real
// data. Threat model, and how each is closed:
//
// - Someone other than the organization's admins reads real data through
//   a sample, or takes one: only an admin, never Grasp staff, checked here
//   from the identity read for the call. No App, workflow or agent reaches
//   it, and the per-record answer goes only to that admin.
// - Values leak into logs, the audit log or the receipt: those carry
//   counts and codes only, never a record's values, fields or ID. The
//   failing record and the transform's issues are in the admin's answer
//   alone, trimmed as a backfill's failure is, and kept nowhere.
// - The sample writes or moves anything: the store reads it in a
//   transaction that writes nothing (store-host.ts, `sampleMigration`),
//   and the transform's output is dropped; nothing of the backfill moves.
// - One owner's data reaches another's transform: on a table read or
//   written by owner the sample is one owner's records (the scan's own
//   rule, `batchOf`), and the transform runs in a fresh isolate with no
//   env and no network, as a backfill's batch does (`transformBatch`).
// - The sample grows without bound, or samples pile up: at most
//   `migrationSampleMaxRows` records within a transform's bytes, in one
//   sandbox call; one dry run of a migration in flight at a time, and a
//   few a minute (`takeLease`).
// - One member's private values reach an admin: a transform's thrown
//   message can carry its record's values verbatim, so on a table read or
//   written by owner the admin gets the issues only for a record they own,
//   and the reason alone otherwise.
// - A sample of the wrong records vouches for a release: only records the
//   release's pending migration still has to transform, from where its
//   backfill stands in the store that version binds (a transformed record
//   keeps its writer's schema hash, so the hash can't tell); none once it
//   is done. The receipt names the release's manifest hash and both
//   schemas. A sandbox that didn't answer records nothing, never a pass.
//
// The transform gets each sampled record's stored fields, as a real batch
// does, not only those its `input` declares: a dry run on a projection
// would fail where the real run passes. It reads no more than the run
// will, and nothing of it leaves the sandbox call but counts and, for the
// admin, the issues.

/** The store `storeId`'s object. */
const storeObject = (
  env: Pick<Env, "DATA_STORES" | "DURABLE_OBJECT_JURISDICTION">,
  storeId: StoreId
) => inJurisdiction(env, env.DATA_STORES).getByName(storeId);

/** A sampled record as the store hands it over (`sampleMigration`). */
const sampledSchema = z.array(
  z.object({
    id: z.string(),
    owner: z.string(),
    revision: z.number(),
    fields: z.record(z.string(), z.json()),
  })
);

/** Most issues, and characters of each, the admin's answer carries. */
const issuesMax = 20;
const issueLength = 500;

/** How long a dry run holds its migration's lease at most. */
const leaseMs = 2 * 60 * 1000;

/** Most dry runs of one migration of a version in a minute. */
const samplesPerMinute = 5;
const minuteMs = 60_000;

/** One migration of one version: what a dry run's lease and cap count. */
interface SampledMigration {
  readonly app: string;
  readonly version: number;
  readonly migration: string;
}

/**
 * Takes a lease on `sampled` for a new dry run, answering its token;
 * refuses with `migration.sample_busy` while another run of it holds one
 * (one in flight per migration), or once `samplesPerMinute` were granted
 * in the last minute, whether or not those runs got as far as a receipt.
 * One statement decides both, so two asking at once can't both have it.
 */
const takeLease = async (
  env: Env,
  sampled: SampledMigration
): Promise<string> => {
  const now = Date.now();
  const token = crypto.randomUUID();
  const [, granted] = await env.DB.batch<{ id: string }>([
    // What no longer counts: let go, and granted over a minute ago.
    env.DB.prepare(
      "DELETE FROM migration_sample_leases WHERE app_id = ? AND version = ? AND migration = ? AND until <= ? AND granted_at <= ?"
    ).bind(
      sampled.app,
      sampled.version,
      sampled.migration,
      now,
      now - minuteMs
    ),
    env.DB.prepare(
      `INSERT INTO migration_sample_leases (id, app_id, version, migration, granted_at, until)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE NOT EXISTS (SELECT 1 FROM migration_sample_leases
          WHERE app_id = ?2 AND version = ?3 AND migration = ?4 AND until > ?5)
        AND (SELECT count(*) FROM migration_sample_leases
          WHERE app_id = ?2 AND version = ?3 AND migration = ?4 AND granted_at > ?7) < ?8
      RETURNING id`
    ).bind(
      token,
      sampled.app,
      sampled.version,
      sampled.migration,
      now,
      now + leaseMs,
      now - minuteMs,
      samplesPerMinute
    ),
  ]);
  if (granted?.results[0]?.id !== token) {
    throw migrationErrors.create("migration.sample_busy");
  }
  return token;
};

/** Lets go of the lease `token` holds: still counted for the minute. */
const releaseLease = async (env: Env, token: string): Promise<void> => {
  await drizzle(env.DB)
    .update(migrationSampleLeases)
    .set({ until: new Date() })
    .where(eq(migrationSampleLeases.id, token));
};

/**
 * The admin `by`'s view of `failure`: the record and its reason, and its
 * issues trimmed, unless the table is `owned` and the record isn't
 * theirs: one member's private values (a thrown message can carry them
 * verbatim) reach only that member, even an admin.
 */
const failureFor = (
  by: Member,
  failure: TransformFailure | null,
  owned: boolean,
  rows: readonly { id: string; owner: string }[]
): MigrationSample["failure"] => {
  if (failure === null) {
    return null;
  }
  const owner = rows.find(({ id }) => id === failure.id)?.owner;
  const shown = !owned || owner === by.userId;
  return {
    record: failure.id,
    reason: failure.reason,
    issues: shown
      ? failure.issues
          .slice(0, issuesMax)
          .map((issue) => issue.slice(0, issueLength))
      : [],
  };
};

/**
 * Dry-runs `input`'s migration on a sample of the real records it would
 * transform, for `by`, an admin and not Grasp staff: its transform, in
 * the sandbox, on at most `input.rows` records of its table it still has
 * to transform, in the store its version binds. One at a time per
 * migration, and a few a minute (`takeLease`). Keeps a receipt with the
 * version's migration evidence and audits it, both without values;
 * answers the admin with the failing record and its issues as well. On a
 * table read or written by owner, the issues (a transform's thrown
 * message can carry the record's values verbatim) only when the admin
 * owns that record; otherwise its reason alone.
 */
export const sampleMigration = async (
  env: Env,
  by: Member,
  input: unknown
): Promise<MigrationSample> => {
  requireAdmin(by);
  requireNotStaff(by);
  const {
    app,
    version,
    migration: name,
    rows: limit = migrationSampleRows,
  } = dataErrors.parse("data.invalid", sampleMigrationSchema, input);
  const release = await loadRelease(env, app, version);
  const declared = Object.hasOwn(release.app.migrations, name)
    ? release.app.migrations[name]
    : undefined;
  const access =
    declared === undefined
      ? undefined
      : release.app.schema.tables[declared.table]?.access;
  if (
    declared === undefined ||
    access === undefined ||
    release.store === null
  ) {
    throw migrationErrors.create("migration.not_declared");
  }
  const owned = access.read === "owner" || access.write === "owner";
  const store = storeIdSchema.parse(release.store.storeId);
  const token = await takeLease(env, { app, version, migration: name });
  try {
    const rows = sampledSchema.parse(
      JSON.parse(
        await storeObject(env, store).sampleMigration(store, {
          table: declared.table,
          migration: name,
          consumer: { resourceId: app, resourceVersion: version },
          limit,
        })
      )
    );
    if (rows.length === 0) {
      // Nothing left, unless an admin abandoned the migration: its
      // backfill is gone, but it never transformed what was left.
      const status = await storeObject(env, store).schemaStatus(
        store,
        release.manifest.schemaHash,
        { resourceId: app, resourceVersion: version }
      );
      if (status.state === "abandoned") {
        throw migrationErrors.create("migration.abandoned");
      }
    }
    const owners = new Set(rows.map(({ owner }) => owner)).size;
    // A sandbox out of reach throws (`SandboxUnavailableError`): nothing
    // is recorded, never a pass.
    const transformed =
      rows.length === 0
        ? undefined
        : await transformBatch(
            env,
            release,
            name,
            rows.map(({ id, owner, fields }) => ({ id, owner, fields }))
          );
    const failure =
      transformed === undefined || transformed.ok ? null : transformed.failure;
    let outcome: MigrationSample["outcome"] = "passed";
    if (transformed === undefined) {
      outcome = "empty";
    } else if (failure !== null) {
      outcome = "failed";
    }
    const sampledAt = new Date();
    const id = crypto.randomUUID();
    const db = drizzle(env.DB);
    await auditedBatch(env, db, [
      db.insert(migrationSamples).values({
        id,
        appId: app,
        version,
        migration: name,
        storeId: store,
        outcome,
        rows: rows.length,
        owners,
        reason: failure?.reason ?? null,
        manifestHash: release.manifestHash,
        fromSchema: declared.fromSchema,
        toSchema: declared.toSchema,
        sampledBy: by.userId,
        sampledAt,
      }),
      outboxed(db, {
        actor: actorOf(by),
        action: "store.migration_sampled",
        target: { type: "store", id: store },
        detail: {
          app,
          version,
          migration: name,
          outcome,
          rows: rows.length,
          owners,
          ...(failure === null ? {} : { reason: failure.reason }),
        },
      }),
    ]);
    log.info("store.migration_sampled", {
      app,
      version,
      outcome,
      rows: rows.length,
      owners,
    });
    return {
      id,
      app,
      version,
      migration: name,
      store,
      outcome,
      rows: rows.length,
      owners,
      sampledAt: sampledAt.toISOString(),
      failure: failureFor(by, failure, owned, rows),
    };
  } finally {
    await releaseLease(env, token);
  }
};
